#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
package_dir="${script_dir}/kwin/dictai-positioner"
package_id="dictai-positioner"
effect_dir="${script_dir}/kwin/dictai-popup-guard"
effect_id="dictai-popup-guard"
rule_id="dictai-definition-no-focus"
data_root="${XDG_DATA_HOME:-${HOME}/.local/share}"
installed_package_dir="${data_root}/kwin/scripts/${package_id}"
installed_script="${data_root}/kwin/scripts/${package_id}/contents/code/main.js"
installed_effect_dir="${data_root}/kwin/effects/${effect_id}"
installed_effect_script="${installed_effect_dir}/contents/code/main.js"

if [[ "$(readlink -f -- "${installed_script}" 2>/dev/null || true)" == "$(readlink -f -- "${package_dir}/contents/code/main.js")" ]]; then
	:
elif kpackagetool6 --type KWin/Script --show "${package_id}" >/dev/null 2>&1; then
	kpackagetool6 --type KWin/Script --upgrade "${package_dir}"
else
	kpackagetool6 --type KWin/Script --install "${package_dir}"
fi

if [[ "$(readlink -f -- "${installed_effect_script}" 2>/dev/null || true)" == "$(readlink -f -- "${effect_dir}/contents/code/main.js")" ]]; then
	:
elif kpackagetool6 --type KWin/Effect --show "${effect_id}" >/dev/null 2>&1; then
	kpackagetool6 --type KWin/Effect --upgrade "${effect_dir}"
else
	kpackagetool6 --type KWin/Effect --install "${effect_dir}"
fi

# KPackage installs copies by default. Replace every installed package file
# with a link to the repository so this checkout remains the single source of
# truth for the running compositor helpers.
ln -sfn "${package_dir}/metadata.json" "${installed_package_dir}/metadata.json"
ln -sfn \
	"${package_dir}/contents/code/main.js" \
	"${installed_package_dir}/contents/code/main.js"
ln -sfn "${effect_dir}/metadata.json" "${installed_effect_dir}/metadata.json"
ln -sfn \
	"${effect_dir}/contents/code/main.js" \
	"${installed_effect_dir}/contents/code/main.js"

kwriteconfig6 \
	--file kwinrc \
	--group Plugins \
	--key "${package_id}Enabled" \
	true

kwriteconfig6 \
	--file kwinrc \
	--group Plugins \
	--key "${effect_id}Enabled" \
	true

# The popup intentionally keeps normal keyboard focus. Remove the old
# acceptfocus=false rule because it blocks copying selected definition text.
existing_rules="$(
	kreadconfig6 --file kwinrulesrc --group General --key rules
)"
filtered_rules=()
IFS=',' read -r -a rule_entries <<<"${existing_rules}"
for rule_entry in "${rule_entries[@]}"; do
	if [[ -n "${rule_entry}" && "${rule_entry}" != "${rule_id}" ]]; then
		filtered_rules+=("${rule_entry}")
	fi
done
updated_rules="$(
	IFS=','
	printf '%s' "${filtered_rules[*]}"
)"
kwriteconfig6 --file kwinrulesrc --group General \
	--key rules "${updated_rules}"
kwriteconfig6 --file kwinrulesrc --group General \
	--key count "${#filtered_rules[@]}"
for rule_key in Description title titlematch acceptfocus acceptfocusrule; do
	kwriteconfig6 --file kwinrulesrc --group "${rule_id}" \
		--key "${rule_key}" --delete ''
done

qdbus6 org.kde.KWin /Scripting \
	org.kde.kwin.Scripting.unloadScript \
	"${package_id}" >/dev/null 2>&1 || true

qdbus6 org.kde.KWin /Scripting \
	org.kde.kwin.Scripting.loadScript \
	"${installed_script}" \
	"${package_id}" >/dev/null

qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start

qdbus6 org.kde.KWin /Effects \
	org.kde.kwin.Effects.unloadEffect \
	"${effect_id}" >/dev/null 2>&1 || true
qdbus6 org.kde.KWin /Effects \
	org.kde.kwin.Effects.loadEffect \
	"${effect_id}" >/dev/null

effect_loaded="$(
	qdbus6 org.kde.KWin /Effects \
		org.kde.kwin.Effects.isEffectLoaded \
		"${effect_id}"
)"
if [[ "${effect_loaded}" != "true" ]]; then
	printf 'Failed to load the DictAI KWin popup guard effect.\n' >&2
	exit 1
fi

qdbus6 org.kde.KWin /KWin org.kde.KWin.reconfigure

printf 'Installed and started the DictAI KWin popup compositor helpers.\n'
