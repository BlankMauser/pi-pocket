from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('control', Path(__file__).parents[1] / 'contrib/usage-watchdog-control.py')
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


def properties(sid, active=False, checking=False):
    return f'Id=usage-watchdog-{sid}.timer\nActiveState={"active" if active else "inactive"}\nUnitFileState={"enabled" if active else "disabled"}\nNextElapseUSecRealtime=Mon 2026-11-09 11:00:00 UTC\n\nId=usage-watchdog-{sid}.service\nActiveState={"activating" if checking else "inactive"}\n'


class ControlTests(unittest.TestCase):
    def test_status_projects_only_safe_fields_and_running_service_is_active(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            (state / 'stopped').mkdir()
            (state / '93063.json').write_text(json.dumps({'at': '2026-11-09T10:20:42+00:00', 'action': 'ok', 'switched': False, 'live': {'provider': 'claude-duriel', 'modelId': 'claude-opus-5-5'}, 'secret': 'must-not-leak'}))
            (state / 'stopped/93063.json').write_text(json.dumps({'at': '2026-11-09T10:42:11+00:00'}))
            (state / '888.json').write_text('{}')
            calls = []
            def runner(args):
                calls.append(args)
                if args[1] == 'list-unit-files':
                    return 'usage-watchdog-93063.timer enabled enabled\nusage-watchdog-77.timer disabled enabled\n'
                if args[1] == 'list-units':
                    return 'usage-watchdog-99.service loaded activating running\n'
                sid = int(args[2].split('-')[-1].split('.')[0])
                return properties(sid, active=sid in [93063, 77], checking=sid == 99)
            result = control.status(state, runner, owner=os.getuid())
            rows = {v['session']: v for v in result['watchdogs']}
            self.assertTrue(rows[93063]['active'])
            self.assertTrue(rows[93063]['stopped'])
            self.assertFalse(rows[93063]['switchingEnabled'])
            self.assertTrue(rows[77]['switchingEnabled'])
            self.assertTrue(rows[99]['switchingEnabled'])
            self.assertTrue(rows[99]['checking'])
            self.assertFalse(rows[888]['switchingEnabled'])
            self.assertEqual(rows[77]['nextCheckAt'], '2026-11-09T11:00:00+00:00')
            self.assertNotIn('must-not-leak', json.dumps(result))

    def test_stop_durable_marker_precedes_only_fixed_systemctl_commands(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            calls = []
            def runner(args):
                calls.append(args)
                self.assertTrue((state / 'stopped/93063.json').exists())
                if args[1] == 'show':
                    return properties(93063, active=len(calls) == 1, checking=len(calls) == 1)
                return ''
            self.assertEqual(control.stop('93063', runner, state, os.getuid()), {'session': 93063, 'stopped': True})
            self.assertEqual(calls[1], ['/usr/bin/systemctl', 'disable', '--now', 'usage-watchdog-93063.timer'])
            self.assertEqual(calls[2], ['/usr/bin/systemctl', 'stop', 'usage-watchdog-93063.service'])
            self.assertEqual(json.loads((state / 'stopped/93063.json').read_text())['session'], 93063)
            with self.assertRaises(RuntimeError):
                control.stop('93063', lambda args: properties(93063, active=True), state, os.getuid())

    def test_stop_stays_anchored_if_state_is_replaced_while_running(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / 'state'
            state.mkdir()
            moved = Path(root) / 'renamed'
            replacement = Path(root) / 'replacement'
            replacement.mkdir()
            calls = []
            def runner(args):
                calls.append(args)
                if len(calls) == 1:
                    state.rename(moved)
                    state.symlink_to(replacement, target_is_directory=True)
                return properties(93063)
            control.stop('93063', runner, state, os.getuid())
            self.assertTrue((moved / 'stopped/93063.json').exists())
            self.assertFalse((replacement / 'stopped').exists())

    def test_directory_replacement_before_marker_write_cannot_redirect_it(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / 'state'
            state.mkdir()
            moved = Path(root) / 'renamed'
            replacement = Path(root) / 'replacement'
            replacement.mkdir()
            original = control.directory
            @contextmanager
            def race(path, owner):
                with original(path, owner) as fd:
                    state.rename(moved)
                    state.symlink_to(replacement, target_is_directory=True)
                    yield fd
            control.directory = race
            try:
                control.stop('93063', lambda args: properties(93063), state, os.getuid())
            finally:
                control.directory = original
            self.assertTrue((moved / 'stopped/93063.json').exists())
            self.assertFalse((replacement / 'stopped').exists())

    def test_rejects_symlink_directories_nonregular_and_untrusted_files(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            state = base / 'state'
            state.mkdir()
            link = base / 'link'
            link.symlink_to(state, target_is_directory=True)
            runner = lambda args: ''
            for path in [link, base / 'absent']:
                with self.assertRaises(OSError):
                    control.status(path, runner, os.getuid())
            (state / 'stopped').symlink_to(base, target_is_directory=True)
            with self.assertRaises(OSError):
                control.stop('93063', runner, state, os.getuid())
            (state / 'stopped').unlink()
            os.mkfifo(state / '93063.json')
            with self.assertRaises(ValueError):
                control.status(state, runner, os.getuid())
            (state / '93063.json').unlink()
            (base / 'data.json').write_text('{}')
            (state / '93063.json').symlink_to(base / 'data.json')
            with self.assertRaises(OSError):
                control.status(state, runner, os.getuid())
            (state / '93063.json').unlink()
            (state / '93063.json').write_text('{}')
            (state / '93063.json').chmod(0o666)
            with self.assertRaises(PermissionError):
                control.status(state, runner, os.getuid())
            state.chmod(0o777)
            with self.assertRaises(PermissionError):
                control.stop('93063', runner, state, os.getuid())

    def test_rejects_bad_invocations_and_ids_without_running_commands(self):
        for argv in [[], ['stop'], ['status', 'extra'], ['start', '123']]:
            with self.assertRaises(ValueError):
                control.main(argv)
        for value in ['0', '-1', '01', '1.1', '1;echo hi', '93063/../1', '9007199254740992', '']:
            with self.assertRaises(ValueError):
                control.stop(value, lambda args: self.fail('command ran'))


if __name__ == '__main__':
    unittest.main()
