#!/usr/bin/env python3
"""
Build and Sync script for DictAI Dictionary Extension (Chrome & Firefox MV3)
Copies shared files to chrome/ and firefox/ target build folders with browser-specific manifest configurations.
"""

import json
import os
import shutil

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
SHARED_DIR = os.path.join(ROOT_DIR, 'shared')
CHROME_DIR = os.path.join(ROOT_DIR, 'chrome')
FIREFOX_DIR = os.path.join(ROOT_DIR, 'firefox')

SHARED_FILES = [
    'background.js',
    'wiktionary.js',
    'content.js',
    'content.css',
    'popup.html',
    'popup.css',
    'popup.js',
    'popup_frame.html',
    'popup_frame.css',
    'popup_copy_guard.js',
    'popup_frame.js',
    'rules.json',
    'word-index.bin',
    'word-index.meta.json',
]

def build_extension(target_dir, is_firefox=False):
    os.makedirs(target_dir, exist_ok=True)

    # Copy icons
    src_icons = os.path.join(SHARED_DIR, 'icons')
    dest_icons = os.path.join(target_dir, 'icons')
    if os.path.exists(src_icons):
        os.makedirs(dest_icons, exist_ok=True)
        for icon in os.listdir(src_icons):
            shutil.copy2(os.path.join(src_icons, icon), os.path.join(dest_icons, icon))

    # Copy shared assets
    for filename in SHARED_FILES:
        src = os.path.join(SHARED_DIR, filename)
        dest = os.path.join(target_dir, filename)
        if os.path.exists(src):
            shutil.copy2(src, dest)

    # Build manifest with correct permissions (removing invalid "windows" string)
    manifest = {
        "manifest_version": 3,
        "name": "DictAI Dictionary Extension",
        "version": "1.0.0",
        "description": "Double-click any word to view a lemmatized DictAI or English Wiktionary definition in a floating popup or standalone OS window.",
        "permissions": [
            "storage",
            "declarativeNetRequest",
            "tabs"
        ],
        "host_permissions": [
            "https://www.dictai.org/*",
            "https://en.wiktionary.org/*",
            "http://127.0.0.1:9235/*"
        ],
        "declarative_net_request": {
            "rule_resources": [
                {
                    "id": "dictai_iframe_rules",
                    "enabled": True,
                    "path": "rules.json"
                }
            ]
        },
        "content_scripts": [
            {
                "matches": ["<all_urls>"],
                "js": ["wiktionary.js", "content.js"],
                "css": ["content.css"],
                "run_at": "document_end"
            }
        ],
        "web_accessible_resources": [
            {
                "resources": [
                    "popup_frame.html",
                    "popup_frame.css",
                    "popup_copy_guard.js",
                    "popup_frame.js",
                    "wiktionary.js",
                    "icons/*"
                ],
                "matches": ["<all_urls>"]
            }
        ],
        "action": {
            "default_popup": "popup.html",
            "default_title": "DictAI Dictionary",
            "default_icon": {
                "16": "icons/icon16.png",
                "48": "icons/icon48.png",
                "128": "icons/icon128.png"
            }
        },
        "icons": {
            "16": "icons/icon16.png",
            "48": "icons/icon48.png",
            "128": "icons/icon128.png"
        }
    }

    if is_firefox:
        manifest["browser_specific_settings"] = {
            "gecko": {
                "id": "dictai-dictionary@dictai.org",
                "strict_min_version": "109.0"
            }
        }
        manifest["background"] = {
            "scripts": ["background.js"]
        }
    else:
        manifest["background"] = {
            "service_worker": "background.js"
        }

    manifest_path = os.path.join(target_dir, 'manifest.json')
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)

    print(f"Successfully built extension in {os.path.relpath(target_dir, ROOT_DIR)}/")

def main():
    print("Building Chrome and Firefox extensions...")
    build_extension(CHROME_DIR, is_firefox=False)
    build_extension(FIREFOX_DIR, is_firefox=True)
    print("Build complete!")

if __name__ == '__main__':
    main()
