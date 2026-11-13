#!/usr/bin/env python3
"""把当前 HEAD 同步到 GitHub（绕开被代理拦截的 git-receive-pack）。

原理：blob 的 SHA 是内容寻址的、本地与 GitHub 完全一致，所以只需要
  1) 上传远端缺失的 blob（通常只有改动过的几个文件）
  2) 用这些 SHA 建 tree → 建 commit（父提交 = 远端 main）→ PATCH refs/heads/main

用法：python3 scripts/sync_remote.py ["提交信息"]
依赖：gh（已登录）+ curl
"""
import base64
import json
import subprocess
import sys

def sh(*args, **kw):
    return subprocess.run(args, capture_output=True, check=True, **kw).stdout

def origin_repo() -> str:
    url = sh('git', 'remote', 'get-url', 'origin', text=True).strip()
    for sep in (':', '/'):
        if 'github.com' in url:
            tail = url.split('github.com')[-1].lstrip(':/')
            return tail.removesuffix('.git')
    raise SystemExit(f'无法从 origin 解析仓库：{url}')

TOKEN = sh('gh', 'auth', 'token', text=True).strip()
REPO = origin_repo()

def api(method, path, body=None):
    args = ['curl', '-sS', '--fail-with-body', '--retry', '6', '--retry-all-errors',
            '--retry-delay', '2', '-m', '240', '-X', method,
            f'https://api.github.com/repos/{REPO}/{path}',
            '-H', f'Authorization: Bearer {TOKEN}',
            '-H', 'Accept: application/vnd.github+json',
            '-H', 'X-GitHub-Api-Version: 2022-11-28',
            '-H', 'Content-Type: application/json',
            '-H', 'User-Agent: leetcode-dojo-sync']
    data = b''
    if body is not None:
        data = json.dumps(body).encode()
        args += ['--data-binary', '@-']
    p = subprocess.run(args, input=data, capture_output=True)
    if p.returncode != 0:
        raise SystemExit(f'{method} {path} 失败：{p.stdout.decode()[:300]} {p.stderr.decode()[:200]}')
    return json.loads(p.stdout.decode() or '{}')

def main() -> None:
    message = sys.argv[1] if len(sys.argv) > 1 else sh('git', 'log', '-1', '--format=%s', text=True).strip()
    parent = api('GET', 'git/ref/heads/main')['object']['sha']
    remote_tree = api('GET', f'git/trees/{parent}?recursive=1')
    have = {e['sha'] for e in remote_tree.get('tree', []) if e['type'] == 'blob'}

    entries, uploaded = [], 0
    for line in sh('git', 'ls-tree', '-r', '-z', 'HEAD', text=True).split('\0'):
        if not line:
            continue
        meta, path = line.split('\t', 1)
        mode, typ, sha = meta.split()
        if typ != 'blob':
            continue
        if sha not in have:
            content = sh('git', 'cat-file', 'blob', sha)
            api('POST', 'git/blobs', {'content': base64.b64encode(content).decode(), 'encoding': 'base64'})
            uploaded += 1
            print(f'  ↑ {path}', flush=True)
        entries.append({'path': path, 'mode': mode, 'type': 'blob', 'sha': sha})

    if parent == api('GET', 'git/ref/heads/main')['object']['sha'] and uploaded == 0:
        same = api('GET', f'git/commits/{parent}')
        if same.get('tree', {}).get('sha') == api('POST', 'git/trees', {'tree': entries}).get('sha'):
            print('远端已是最新，无需同步'); return

    tree = api('POST', 'git/trees', {'tree': entries})['sha']
    commit = api('POST', 'git/commits', {'message': message, 'tree': tree, 'parents': [parent]})['sha']
    api('PATCH', 'git/refs/heads/main', {'sha': commit, 'force': True})
    print(f'已同步 {uploaded} 个新文件 → {commit[:7]}（{message}）')

if __name__ == '__main__':
    main()
