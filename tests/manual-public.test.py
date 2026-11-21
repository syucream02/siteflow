import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('manual_public', pathlib.Path(__file__).parents[1] / 'deploy/manual-public.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class ManualReleaseTests(unittest.TestCase):
    def test_unknown_mode_has_no_container_action(self):
        with patch.object(mod.sys, 'argv', ['tool', 'publish']), patch.object(mod, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'INVALID_MODE'):
                mod.main()
            run.assert_not_called()

    def test_image_drift_refused_before_start(self):
        with patch.object(mod, 'inspect', return_value={}), patch.object(mod, 'signature', return_value={'image': 'changed', 'mounts': []}), patch.object(mod, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'CONTAINER_CONFIG_DRIFT'):
                mod.start(mod.APP, {'containers': {mod.APP: {'image': 'approved', 'mounts': []}}})
            run.assert_not_called()

    def test_unhealthy_db_prevents_app_start(self):
        with patch.object(mod, 'validate', side_effect=[{'State': {'Running': False}}, {'State': {'Running': True, 'Health': {'Status': 'unhealthy'}}}]), patch.object(mod, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'MYSQL_NOT_HEALTHY'):
                mod.start(mod.APP, {})
            run.assert_not_called()

    def test_running_app_not_restarted(self):
        app = {'Id': 'fixed-app', 'State': {'Running': True}}
        db = {'State': {'Running': True, 'Health': {'Status': 'healthy'}}}
        with patch.object(mod, 'validate', side_effect=[app, db, app]), patch.object(mod, 'run') as run, patch.object(mod, 'ready'):
            mod.start(mod.APP, {})
            run.assert_not_called()

    def test_stopped_app_starts_fixed_id_only(self):
        app = {'Id': 'fixed-app', 'State': {'Running': False}}
        db = {'State': {'Running': True, 'Health': {'Status': 'healthy'}}}
        healthy = {'Id': 'fixed-app', 'State': {'Running': True}}
        with patch.object(mod, 'validate', side_effect=[app, db, healthy]), patch.object(mod, 'run') as run, patch.object(mod, 'ready'):
            mod.start(mod.APP, {})
            run.assert_called_once_with(['docker', 'start', 'fixed-app'])

    def test_mount_mismatch_refused(self):
        with patch.object(mod.os, 'geteuid', return_value=0, create=True), patch.object(mod, 'run', return_value='{"filesystems":[{"uuid":"wrong","fstype":"xfs"}]}'):
            with self.assertRaisesRegex(RuntimeError, 'EBS_MOUNT_MISMATCH'):
                mod.guard()

    def test_mount_order_only_is_equivalent(self):
        a = {'mounts': [{'src': '/a', 'dest': '/x', 'rw': False}, {'src': '/b', 'dest': '/y', 'rw': False}]}
        b = {'mounts': list(reversed(a['mounts']))}
        self.assertEqual(mod.canonical_signature(a), mod.canonical_signature(b))

    def test_mount_permission_change_still_detected(self):
        a = {'mounts': [{'src': '/a', 'dest': '/x', 'rw': False}]}
        b = {'mounts': [{'src': '/a', 'dest': '/x', 'rw': True}]}
        self.assertNotEqual(mod.canonical_signature(a), mod.canonical_signature(b))

    def test_duplicate_mount_target_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'DUPLICATE_MOUNT_TARGET'):
            mod.canonical_signature({'mounts': [{'src': '/a', 'dest': '/x', 'rw': False}, {'src': '/b', 'dest': '/x', 'rw': False}]})


if __name__ == '__main__':
    unittest.main()
