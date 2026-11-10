"""Internal bootstrap adapter using the installed gcloud SDK auth/transport.

Receives the exact database target/password only on stdin. Never resets a user.
The parent bootstrap is plan-only unless explicitly applied; this helper creates
only the fixed OpenGen user in the fixed OpenGen instance after a read-only guard.
"""
import argparse
import json
import os
import re
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--sdk-root', required=True)
args = parser.parse_args()
operation = None
try:
    payload = json.load(sys.stdin)
    if set(payload) != {'project', 'instance', 'username', 'password'}:
        raise ValueError('Unexpected fields')
    if not re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]', payload['project']):
        raise ValueError('Invalid project')
    if payload['instance'] != 'opengen-db' or payload['username'] != 'opengen':
        raise ValueError('Unexpected OpenGen target')
    if not re.fullmatch(r'[a-f0-9]{64}', payload['password']):
        raise ValueError('Invalid credential shape')
    root = os.path.realpath(args.sdk_root)
    if not os.path.isabs(root) or not os.path.isfile(os.path.join(root, 'lib', 'googlecloudsdk', '__init__.py')):
        raise ValueError('Expected installed Google SDK')
    sys.path.insert(0, os.path.join(root, 'lib'))
    sys.path.insert(0, os.path.join(root, 'lib', 'third_party'))
    from googlecloudsdk.api_lib.sql import api_util
    from googlecloudsdk.core import properties
    properties.VALUES.core.log_http.Set(False)
    client = api_util.SqlClient(api_util.API_VERSION_DEFAULT)
    api, messages = client.sql_client, client.sql_messages
    users = api.users.List(messages.SqlUsersListRequest(project=payload['project'], instance=payload['instance']))
    if any(user.name == payload['username'] for user in users.items):
        print(json.dumps({'existing': True, 'passwordReset': False}))
        sys.exit(0)
    result = api.users.Insert(messages.SqlUsersInsertRequest(
        project=payload['project'], instance=payload['instance'],
        user=messages.User(kind='sql#user', project=payload['project'], instance=payload['instance'],
            name=payload['username'], password=payload['password'], type=messages.User.TypeValueValuesEnum.BUILT_IN)))
    operation = result.name
    print(json.dumps({'name': operation, 'passwordReset': False}))
except Exception:
    print(json.dumps({'status': 'unknown-or-failed', 'operation': operation,
        'next': 'Reconcile the named SQL operation/user read-only before another create. Private payload suppressed.'}))
    sys.exit(1)
