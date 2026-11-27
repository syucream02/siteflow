import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('manual_public', pathlib.Path(__file__).parents[1] / 'deploy/manual-public.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class ManualReleaseTests(unittest.TestCase):
    def test_missing_public_origin_is_rejected_before_state_or_docker_access(self):
        with patch.object(mod.sys, 'argv', ['manual-public.py', 'start-app']), \
             patch.dict(mod.os.environ, {'SITEFLOW_PUBLIC_ORIGIN': ''}), \
             patch.object(mod, 'record') as record, patch.object(mod, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'SITEFLOW_PUBLIC_ORIGIN_REQUIRED'):
                mod.main()
            record.assert_not_called()
            run.assert_not_called()

    def test_public_origin_rejects_placeholders_and_non_origin_urls(self):
        values = ('', 'REQUIRES_APPROVED_PUBLIC_HOST', 'http://public.invalid',
                  'https://localhost', 'https://service.invalid/path',
                  'https://user@service.invalid', 'https://service.invalid:8443',
                  'https://private.internal', 'https://demo.example.org')
        for value in values:
            with self.subTest(value='redacted'):
                with patch.dict(mod.os.environ, {'SITEFLOW_PUBLIC_ORIGIN': value}):
                    with self.assertRaisesRegex(RuntimeError, 'SITEFLOW_PUBLIC_ORIGIN_'):
                        mod.validate_public_origin(value)

    def test_ready_uses_validated_origin_host_for_loopback_probe(self):
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return b'{"ok":true}'

        with patch.object(mod, 'PUBLIC', 'https://siteflow.invalid'), \
             patch.object(mod.urllib.request, 'urlopen', return_value=Response()) as urlopen:
            mod.ready()

        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, 'http://127.0.0.1:3001/api/ready')
        self.assertEqual(request.get_header('Host'), 'siteflow.invalid')

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
