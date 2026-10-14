"""Independent fixture-only storage migration fences."""
import os
os.environ['AI_DM_CHATKIT_DATABASE_PATH']=':memory:'
import asyncio
import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from datetime import datetime,timezone
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'chatkit-server'))
from app import SqliteStore
from chatkit.types import ThreadMetadata

class MigrationGate(unittest.IsolatedAsyncioTestCase):
    async def test_empty_target_imports_legacy_once_nonempty_preserved(self):
        with tempfile.TemporaryDirectory() as directory,contextlib.redirect_stdout(io.StringIO()):
            legacy=Path(directory)/'legacy.sqlite'; target=Path(directory)/'target.sqlite'
            owner={'worldId':'fixture','userId':'gm'}
            source=SqliteStore(str(legacy));await source.save_thread(ThreadMetadata(id='old',created_at=datetime.now(timezone.utc)),owner);source.db.close()
            empty=SqliteStore(str(target));empty.db.close()
            with patch.dict(os.environ,{'AI_DM_CHATKIT_LEGACY_DATABASE_PATH':str(legacy)}):
                migrated=SqliteStore(str(target)); self.assertEqual((await migrated.load_thread('old',owner)).id,'old')
                self.assertEqual(migrated.db.execute('SELECT COUNT(*) FROM storage_migration').fetchone()[0],1)
                await migrated.save_thread(ThreadMetadata(id='new',created_at=datetime.now(timezone.utc)),owner);migrated.db.close()
                reopened=SqliteStore(str(target));self.assertEqual((await reopened.load_thread('new',owner)).id,'new');self.assertEqual(reopened.db.execute('SELECT COUNT(*) FROM storage_migration').fetchone()[0],1);reopened.db.close()
            source=SqliteStore(str(legacy));self.assertEqual(source.db.execute('SELECT COUNT(*) FROM threads').fetchone()[0],1);source.db.close()
    async def test_nonempty_destination_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            legacy=Path(directory)/'legacy.sqlite'; target=Path(directory)/'target.sqlite'
            owner={'worldId':'fixture','userId':'gm'}
            source=SqliteStore(str(legacy));await source.save_thread(ThreadMetadata(id='legacy',created_at=datetime.now(timezone.utc)),owner);source.db.close()
            current=SqliteStore(str(target));await current.save_thread(ThreadMetadata(id='current',created_at=datetime.now(timezone.utc)),owner);current.db.close()
            with patch.dict(os.environ,{'AI_DM_CHATKIT_LEGACY_DATABASE_PATH':str(legacy)}):
                preserved=SqliteStore(str(target));self.assertEqual([row[0] for row in preserved.db.execute('SELECT id FROM threads')],['current']);preserved.db.close()
if __name__=='__main__':unittest.main()
