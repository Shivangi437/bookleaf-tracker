#!/usr/bin/env python3
"""Deploy public/ folder to Netlify via API (no auth needed for Netlify Drop)"""
import hashlib
import json
import os
import requests

DEPLOY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')

def sha1_file(path):
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()

def collect_files(base_dir):
    files = {}
    for root, dirs, filenames in os.walk(base_dir):
        for fn in filenames:
            full = os.path.join(root, fn)
            rel = '/' + os.path.relpath(full, base_dir)
            files[rel] = { 'path': full, 'sha1': sha1_file(full) }
    return files

def deploy():
    print(f"Collecting files from {DEPLOY_DIR}...")
    files = collect_files(DEPLOY_DIR)

    # Build the files map: { "/path": sha1 }
    file_hashes = { rel: info['sha1'] for rel, info in files.items() }

    print(f"Found {len(files)} files:")
    for rel in sorted(files.keys()):
        size = os.path.getsize(files[rel]['path'])
        print(f"  {rel} ({size:,} bytes)")

    # Step 1: Create deploy
    print("\nCreating Netlify deploy...")
    resp = requests.post('https://api.netlify.com/api/v1/sites', json={
        'files': file_hashes
    })

    if resp.status_code not in (200, 201):
        print(f"Error creating site: {resp.status_code} {resp.text}")
        return

    deploy_data = resp.json()
    site_id = deploy_data.get('id') or deploy_data.get('site_id')
    deploy_id = deploy_data.get('deploy_id') or deploy_data.get('id')

    # Check for required files
    required = deploy_data.get('required', [])
    site_url = deploy_data.get('url') or deploy_data.get('ssl_url') or deploy_data.get('subdomain')

    print(f"Site ID: {site_id}")
    print(f"Deploy ID: {deploy_id}")
    print(f"Files to upload: {len(required)}")

    # Step 2: Upload required files
    for sha in required:
        # Find which file has this sha
        for rel, info in files.items():
            if info['sha1'] == sha:
                print(f"  Uploading {rel}...")
                with open(info['path'], 'rb') as f:
                    upload_resp = requests.put(
                        f'https://api.netlify.com/api/v1/deploys/{deploy_id}/files{rel}',
                        data=f.read(),
                        headers={'Content-Type': 'application/octet-stream'}
                    )
                    if upload_resp.status_code not in (200, 201):
                        print(f"    Error: {upload_resp.status_code} {upload_resp.text[:200]}")
                    else:
                        print(f"    OK")
                break

    print(f"\n{'='*60}")
    print(f"DEPLOYED!")

    # Get final site info
    site_resp = requests.get(f'https://api.netlify.com/api/v1/sites/{site_id}')
    if site_resp.ok:
        site_info = site_resp.json()
        url = site_info.get('ssl_url') or site_info.get('url') or f"https://{site_info.get('subdomain')}.netlify.app"
        name = site_info.get('name', site_id)
        print(f"Site: {name}")
        print(f"URL:  {url}")
        print(f"\nTeam URLs:")
        print(f"  Vandana: {url}?view=Vandana")
        print(f"  Sapna:   {url}?view=Sapna")
        print(f"  Tannu:   {url}?view=Tannu")
        print(f"  Roosha:  {url}?view=Roosha")
        print(f"  Admin:   {url}?view=admin")
    else:
        print(f"URL: Check Netlify dashboard")

    print(f"{'='*60}")

if __name__ == '__main__':
    deploy()
