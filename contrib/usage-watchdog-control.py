#!/usr/bin/python3
"""Narrow, root-owned status/stop bridge for Pocket's existing usage watchdogs."""
from contextlib import contextmanager
import datetime as dt
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid

STATE = Path('/var/lib/matchamill-pi-pocket/usage-watchdog')
ID = re.compile(r'[1-9][0-9]{0,15}')
UNIT = re.compile(r'usage-watchdog-([1-9][0-9]{0,15})\.(timer|service)')
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def session_id(value):
    if not isinstance(value, str) or not ID.fullmatch(value) or int(value) > 9007199254740991:
        raise ValueError('Invalid session ID')
    return int(value)


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=15)
    # systemd returns 1 with no output when no unit files match the filter.
    empty = args[1] == 'list-unit-files' and result.returncode == 1 and not result.stdout and not result.stderr
    if not empty:
        result.check_returncode()
    return result.stdout


def check_owner(info, owner):
    if info.st_uid != owner or info.st_mode & 0o022:
        raise PermissionError('Watchdog state must be owned and writable only by root')


@contextmanager
def directory(path, owner=0):
    """No symlinks at any component; retain the validated inode if its parent is renamed."""
    path = Path(path)
    if not path.is_absolute():
        raise ValueError('Absolute state path required')
    fd = os.open('/', DIRECTORY)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        check_owner(os.fstat(fd), owner)
        yield fd
    finally:
        os.close(fd)


@contextmanager
def stopped_directory(parent, owner, create=False):
    if create:
        try:
            os.mkdir('stopped', 0o700, dir_fd=parent)
            os.fsync(parent)
        except FileExistsError:
            pass
    try:
        fd = os.open('stopped', DIRECTORY, dir_fd=parent)
    except FileNotFoundError:
        yield None
        return
    try:
        check_owner(os.fstat(fd), owner)
        yield fd
    finally:
        os.close(fd)


def read_json(parent, name, owner):
    if parent is None:
        return None
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
    except FileNotFoundError:
        return None
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        check_owner(info, owner)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 32768:
            raise ValueError('Invalid watchdog state file')
        value = json.loads(stream.read(32769))
        if not isinstance(value, dict):
            raise ValueError('Invalid watchdog state')
        return value


def text(value, length=160):
    return value[:length] if isinstance(value, str) else None


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).isoformat()
    except ValueError:
        return None


def system_time(value):
    try:
        return dt.datetime.strptime(value, '%a %Y-%m-%d %H:%M:%S %Z').replace(tzinfo=dt.timezone.utc).isoformat()
    except (ValueError, TypeError):
        return None


def unit_properties(sid, runner):
    output = runner(['/usr/bin/systemctl', 'show', f'usage-watchdog-{sid}.timer', f'usage-watchdog-{sid}.service', '-p', 'Id', '-p', 'ActiveState', '-p', 'UnitFileState', '-p', 'NextElapseUSecRealtime'])
    units = {}
    for block in output.strip().split('\n\n'):
        props = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
        if props.get('Id'):
            units[props['Id'].rsplit('.', 1)[-1]] = props
    return units


def status(state=STATE, runner=run, owner=0):
    ids = set()
    for command in [
        ['list-unit-files', 'usage-watchdog-*.timer', 'usage-watchdog-*.service'],
        ['list-units', '--all', 'usage-watchdog-*'],
    ]:
        output = runner(['/usr/bin/systemctl', *command, '--no-legend', '--no-pager', '--plain'])
        for line in output.splitlines():
            parts = line.split()
            match = UNIT.fullmatch(parts[0]) if parts else None
            if match:
                ids.add(session_id(match[1]))
    rows = []
    with directory(state, owner) as state_fd, stopped_directory(state_fd, owner) as stop_fd:
        for fd in [state_fd, stop_fd]:
            if fd is not None:
                for name in os.listdir(fd):
                    if name.endswith('.json') and ID.fullmatch(name[:-5]):
                        ids.add(session_id(name[:-5]))
        for sid in sorted(ids, reverse=True):
            units = unit_properties(sid, runner)
            props = units.get('timer', {})
            checking = units.get('service', {}).get('ActiveState') in ['active', 'activating', 'deactivating']
            last = read_json(state_fd, f'{sid}.json', owner) or {}
            stopped = read_json(stop_fd, f'{sid}.json', owner)
            blocked = stopped is not None
            active = checking or props.get('ActiveState') in ['active', 'activating']
            live = last.get('live') if isinstance(last.get('live'), dict) else {}
            rows.append({
                'session': sid, 'active': active, 'checking': checking, 'stopped': blocked,
                'enabled': props.get('UnitFileState') in ['enabled', 'enabled-runtime', 'static'],
                'switchingEnabled': active and not blocked,
                'nextCheckAt': system_time(props.get('NextElapseUSecRealtime')),
                'lastCheckedAt': timestamp(last.get('at')),
                'currentProvider': text(live.get('provider')),
                'modelId': text(live.get('modelId')),
                'lastAction': last.get('action') if last.get('action') in ['ok', 'switch', 'stuck', 'unknown', 'stopped'] else None,
                'switched': last.get('switched') is True,
                'stoppedAt': timestamp((stopped or {}).get('at')),
            })
    return {'available': True, 'watchdogs': rows}


def stop(value, runner=run, state=STATE, owner=0):
    sid = session_id(value)
    # Never delegate path-based privileged writes to the older finish command.
    with directory(state, owner) as state_fd, stopped_directory(state_fd, owner, create=True) as stop_fd:
        name = f'{sid}.json'
        temporary = f'.{sid}.{uuid.uuid4().hex}.new'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=stop_fd)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump({'session': sid, 'reason': 'manual', 'at': dt.datetime.now(dt.timezone.utc).isoformat()}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, name, src_dir_fd=stop_fd, dst_dir_fd=stop_fd)
            os.fsync(stop_fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=stop_fd)
            except FileNotFoundError:
                pass
        units = unit_properties(sid, runner)
        if units.get('timer', {}).get('UnitFileState'):
            runner(['/usr/bin/systemctl', 'disable', '--now', f'usage-watchdog-{sid}.timer'])
        elif units.get('timer', {}).get('ActiveState') in ['active', 'activating', 'deactivating']:
            runner(['/usr/bin/systemctl', 'stop', f'usage-watchdog-{sid}.timer'])
        if units.get('service', {}).get('ActiveState') in ['active', 'activating', 'deactivating']:
            runner(['/usr/bin/systemctl', 'stop', f'usage-watchdog-{sid}.service'])
        after = unit_properties(sid, runner)
        if any(props.get('ActiveState') in ['active', 'activating', 'deactivating'] for props in after.values()) or after.get('timer', {}).get('UnitFileState') in ['enabled', 'enabled-runtime']:
            raise RuntimeError('Watchdog stop was not verified')
    return {'session': sid, 'stopped': True}


def main(argv):
    if argv == ['status']:
        return status()
    if len(argv) == 2 and argv[0] == 'stop':
        return stop(argv[1])
    raise ValueError('Expected status or stop SESSION')


if __name__ == '__main__':
    try:
        print(json.dumps(main(sys.argv[1:])))
    except Exception:
        print(json.dumps({'error': 'Usage watchdog operation failed'}))
        sys.exit(1)
