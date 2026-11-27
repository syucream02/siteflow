#!/usr/bin/python3
"""Public template of the verified manual-release tool; configure EBS identity first.

The placeholders deliberately fail the mount guard. The configured copy already
running on EC2 is separate and is not changed by publishing this source.
"""
import datetime
import hashlib
import ipaddress
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request

BASE = pathlib.Path('/srv/siteflow-mysql')
ROOT = BASE / 'config/manual-public-v1'
APP = 'siteflow-next-candidate'
DB = 'siteflow-production-mysql-1'
UUID = 'SET_DATA_EBS_UUID'
VOLUME = 'SET_DATA_EBS_SERIAL'
PUBLIC = None
PUBLIC_ENV_FILE = pathlib.Path('/etc/siteflow/manual-public.env')
ENV_KEYS = ('NODE_ENV', 'SITEFLOW_WORKSPACE_MODE', 'SITEFLOW_PUBLIC_ORIGIN',
            'SITEFLOW_DB_HOST', 'SITEFLOW_DB_PORT', 'SITEFLOW_DB_NAME',
            'SITEFLOW_DB_USER', 'SITEFLOW_DB_TLS', 'SITEFLOW_DB_CA_FILE',
            'SITEFLOW_DB_PASSWORD_FILE', 'SITEFLOW_AUTH_SECRET_FILE')


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def validate_public_origin(origin):
    require(origin and origin == origin.strip() and 'REQUIRES_APPROVED_' not in origin,
            'SITEFLOW_PUBLIC_ORIGIN_REQUIRED')
    try:
        parsed = urllib.parse.urlsplit(origin)
        port = parsed.port
    except ValueError:
        raise RuntimeError('SITEFLOW_PUBLIC_ORIGIN_INVALID') from None
    host = parsed.hostname
    require(parsed.scheme == 'https' and host and parsed.netloc == parsed.netloc.lower() and
            parsed.username is None and parsed.password is None and parsed.path == '' and
            not parsed.query and not parsed.fragment and port is None and
            origin == 'https://' + parsed.netloc,
            'SITEFLOW_PUBLIC_ORIGIN_INVALID')
    require(host not in ('localhost', 'example.com', 'example.net', 'example.org') and
            not host.endswith(('.localhost', '.local', '.lan', '.intranet', '.internal',
                               '.example', '.example.com', '.example.net', '.example.org',
                               '.invalid', '.test')),
            'SITEFLOW_PUBLIC_ORIGIN_INVALID')
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        require(re.fullmatch(r'(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}', host) is not None,
                'SITEFLOW_PUBLIC_ORIGIN_INVALID')
    else:
        require(address.is_global, 'SITEFLOW_PUBLIC_ORIGIN_INVALID')
    return origin


def required_public_origin():
    origin = os.environ.get('SITEFLOW_PUBLIC_ORIGIN', '')
    require(origin and origin == origin.strip() and 'REQUIRES_APPROVED_' not in origin,
            'SITEFLOW_PUBLIC_ORIGIN_REQUIRED')
    directory = PUBLIC_ENV_FILE.parent
    require(not directory.is_symlink() and directory.resolve() == directory and
            directory.stat().st_uid == 0 and directory.stat().st_mode & 0o777 == 0o700,
            'SITEFLOW_PUBLIC_ORIGIN_DIRECTORY_INVALID')
    require(hasattr(os, 'O_NOFOLLOW'), 'SITEFLOW_PUBLIC_ORIGIN_FILE_UNSUPPORTED')
    try:
        fd = os.open(PUBLIC_ENV_FILE, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise RuntimeError('SITEFLOW_PUBLIC_ORIGIN_FILE_INVALID') from None
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                info.st_mode & 0o777 == 0o600 and info.st_nlink == 1 and
                0 < info.st_size <= 4096,
                'SITEFLOW_PUBLIC_ORIGIN_FILE_INVALID')
        try:
            lines = os.read(fd, 4097).decode('utf-8').splitlines()
        except (OSError, UnicodeError):
            raise RuntimeError('SITEFLOW_PUBLIC_ORIGIN_FILE_INVALID') from None
    finally:
        os.close(fd)
    prefix = 'SITEFLOW_PUBLIC_ORIGIN='
    require(len(lines) == 1 and lines[0].startswith(prefix),
            'SITEFLOW_PUBLIC_ORIGIN_FILE_INVALID')
    configured = lines[0][len(prefix):]
    require(configured == origin, 'SITEFLOW_PUBLIC_ORIGIN_FILE_MISMATCH')
    return validate_public_origin(configured)


def run(args, timeout=30):
    proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=timeout, env={**os.environ, 'DOCKER_HOST': 'unix:///var/run/docker.sock'})
    require(proc.returncode == 0, 'COMMAND_FAILED_' + pathlib.Path(args[0]).name)
    return proc.stdout.decode().strip()


def guard():
    require(os.geteuid() == 0, 'ROOT_REQUIRED')
    mount = json.loads(run(['findmnt', '--json', '--mountpoint', str(BASE),
                           '--output', 'SOURCE,UUID,FSTYPE']))['filesystems'][0]
    require(mount['uuid'] == UUID and mount['fstype'] == 'xfs', 'EBS_MOUNT_MISMATCH')
    require(run(['lsblk', '-dn', '-o', 'SERIAL', mount['source']]).replace('-', '') == VOLUME,
            'EBS_VOLUME_MISMATCH')
    require(ROOT.resolve() == ROOT and ROOT.is_dir(), 'RECORD_DIRECTORY_INVALID')
    require(ROOT.stat().st_uid == 0 and ROOT.stat().st_mode & 0o777 == 0o700, 'RECORD_DIRECTORY_MODE')


def record():
    guard()
    p = ROOT / 'release.json'
    require(not p.is_symlink() and p.stat().st_uid == 0 and p.stat().st_mode & 0o777 == 0o600,
            'RECORD_MODE')
    return json.loads(p.read_text())


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def signature(c):
    env = dict(v.split('=', 1) for v in c['Config']['Env'] if '=' in v)
    return {'id': c['Id'], 'image': c['Image'],
            'env': {k: env[k] for k in ENV_KEYS if k in env},
            'mounts': [{'src': m['Source'], 'dest': m['Destination'], 'rw': m['RW']} for m in c['Mounts']],
            'ports': c['HostConfig']['PortBindings'],
            'memory': c['HostConfig']['Memory'], 'swap': c['HostConfig']['MemorySwap'],
            'restart': c['HostConfig']['RestartPolicy'], 'readonly': c['HostConfig']['ReadonlyRootfs'],
            'ulimits': c['HostConfig']['Ulimits'], 'log': c['HostConfig']['LogConfig']['Type']}


def canonical_signature(value):
    value = dict(value)
    mounts = value['mounts']
    require(len({m['dest'] for m in mounts}) == len(mounts), 'DUPLICATE_MOUNT_TARGET')
    value['mounts'] = sorted(mounts, key=lambda m: (m['dest'], m['src'], m['rw']))
    return value


def validate(name, rec, check_public_origin=True):
    c = inspect(name)
    require(canonical_signature(signature(c)) == canonical_signature(rec['containers'][name]), 'CONTAINER_CONFIG_DRIFT')
    require(not c['State']['OOMKilled'], 'CONTAINER_OOM')
    require(c['HostConfig']['RestartPolicy']['Name'] == 'no', 'RESTART_BYPASSES_GUARD')
    require(c['HostConfig']['MemorySwap'] == c['HostConfig']['Memory'] and
            any(u['Name'] == 'core' and u['Hard'] == 0 for u in c['HostConfig']['Ulimits']),
            'SWAP_CORE_GUARD')
    if name == APP:
        env = signature(c)['env']
        require(env['SITEFLOW_DB_NAME'] == 'siteflow_public_app' and
                (PUBLIC is None or not check_public_origin or env['SITEFLOW_PUBLIC_ORIGIN'] == PUBLIC) and env['SITEFLOW_DB_TLS'] == 'required',
                'APP_TARGET_MISMATCH')
        require(c['HostConfig']['PortBindings'] == {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3001'}]},
                'APP_PORT_MISMATCH')
        for filename in ('db-password', 'auth-secret'):
            path = BASE / 'secrets/candidate' / filename
            require(not path.is_symlink() and path.is_file() and path.resolve() == path and
                    path.stat().st_uid == 1000 and path.stat().st_mode & 0o777 == 0o400,
                    'SECRET_FILE_PROTECTION')
    else:
        require(not c['HostConfig']['PortBindings'], 'MYSQL_PORT_PUBLISHED')
        volume = json.loads(run(['docker', 'volume', 'inspect', 'siteflow-production-mysql']))[0]
        require(volume['Options'] == {'device': str(BASE / 'mysql'), 'o': 'bind', 'type': 'none'},
                'MYSQL_DATA_VOLUME_MISMATCH')
        require((BASE / 'mysql/auto.cnf').is_file() and (BASE / 'mysql/mysql').is_dir(),
                'EXISTING_DATABASE_REQUIRED')
        for filename, mode, uid in [('mysql-root-password', 0o600, 0), ('root-client.cnf', 0o400, 0)]:
            p = BASE / 'secrets' / filename
            require(p.is_file() and not p.is_symlink() and p.resolve() == p and
                    p.stat().st_uid == uid and p.stat().st_mode & 0o777 == mode,
                    'MYSQL_SECRET_FILE_PROTECTION')
    return c


def ready():
    origin = validate_public_origin(PUBLIC)
    host = urllib.parse.urlsplit(origin).hostname
    require(host is not None, 'PUBLIC_ORIGIN_HOST_REQUIRED')
    req = urllib.request.Request('http://127.0.0.1:3001/api/ready',
                                 headers={'Host': host, 'X-Forwarded-Proto': 'https'})
    with urllib.request.urlopen(req, timeout=5) as r:
        require(r.status == 200 and json.loads(r.read(4096)).get('ok') is True, 'APP_NOT_READY')


def start(name, rec):
    c = validate(name, rec)
    if name == APP:
        db = validate(DB, rec)
        require(db['State']['Running'] and db['State']['Health']['Status'] == 'healthy', 'MYSQL_NOT_HEALTHY')
    if not c['State']['Running']:
        # Existing ID only: never pull, create, compose up, migrate, or initialize.
        run(['docker', 'start', c['Id']])
    for _ in range(60):
        try:
            c = validate(name, rec)
            require(c['State']['Running'], 'CONTAINER_NOT_RUNNING')
            if name == APP:
                ready()
            else:
                require(c['State']['Health']['Status'] == 'healthy', 'MYSQL_NOT_HEALTHY')
            return
        except (RuntimeError, OSError, ValueError):
            time.sleep(1)
    raise RuntimeError('START_HEALTH_TIMEOUT_MANUAL_REVIEW')


def log_status(rec):
    status = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    for name in (APP, DB):
        try:
            c = validate(name, rec)
            status[name] = {'running': c['State']['Running'], 'oom': c['State']['OOMKilled'],
                            'health': c['State'].get('Health', {}).get('Status')}
        except Exception:
            status[name] = {'check': 'failed'}
    try:
        ready()
        status['ready'] = True
    except Exception:
        status['ready'] = False
    status['availableKiB'] = int(next(x.split()[1] for x in pathlib.Path('/proc/meminfo').read_text().splitlines()
                                    if x.startswith('MemAvailable:')))
    status['freeBytes'] = {str(p): os.statvfs(p).f_bavail * os.statvfs(p).f_frsize for p in (BASE, pathlib.Path('/'))}
    path = ROOT / 'health.jsonl'
    for p in (path, *(ROOT / ('health.jsonl.' + str(n)) for n in range(1, 4))):
        require(not p.is_symlink(), 'LOG_SYMLINK')
    if path.exists() and path.stat().st_size >= 1024 * 1024:
        for n in (2, 1):
            src = ROOT / ('health.jsonl.' + str(n))
            if src.exists():
                os.replace(src, ROOT / ('health.jsonl.' + str(n + 1)))
        os.replace(path, ROOT / 'health.jsonl.1')
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as f:
        f.write(json.dumps(status) + '\n')
    return status


def main():
    global PUBLIC
    PUBLIC = None
    require(len(sys.argv) == 2 and sys.argv[1] in ('check', 'monitor', 'start-app', 'start-mysql', 'stop-app'),
            'INVALID_MODE')
    mode = sys.argv[1]
    if mode in ('check', 'monitor', 'start-app'):
        PUBLIC = required_public_origin()
    rec = record()
    if mode == 'monitor':
        log_status(rec)
    elif mode == 'check':
        for name in (APP, DB):
            c = validate(name, rec)
            require(c['State']['Running'], 'CONTAINER_NOT_RUNNING')
        ready()
    elif mode == 'stop-app':
        c = validate(APP, rec, check_public_origin=False)
        if c['State']['Running']:
            run(['docker', 'stop', '--time', '30', c['Id']], timeout=40)
    else:
        start(APP if mode == 'start-app' else DB, rec)
    print('MANUAL_PUBLIC_' + mode.upper().replace('-', '_') + '_OK')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # No raw command output, credentials, SQL data, URLs, or request headers.
        print(str(exc) if isinstance(exc, RuntimeError) else 'MANUAL_PUBLIC_CHECK_FAILED', file=sys.stderr)
        sys.exit(1)
