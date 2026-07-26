#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
package_dir="${script_dir}/kwin/dictai-positioner"
package_id="dictai-positioner"
effect_dir="${script_dir}/kwin/dictai-popup-guard"
effect_id="dictai-popup-guard"
rule_id="dictai-definition-no-focus"
data_root="${XDG_DATA_HOME:-${HOME}/.local/share}"
installed_script="${data_root}/kwin/scripts/${package_id}/contents/code/main.js"

if kpackagetool6 --type KWin/Script --show "${package_id}" >/dev/null 2>&1; then
	kpackagetool6 --type KWin/Script --upgrade "${package_dir}"
else
	kpackagetool6 --type KWin/Script --install "${package_dir}"
fi

if kpackagetool6 --type KWin/Effect --show "${effect_id}" >/dev/null 2>&1; then
	kpackagetool6 --type KWin/Effect --upgrade "${effect_dir}"
else
	kpackagetool6 --type KWin/Effect --install "${effect_dir}"
fi

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

# Native Wayland windows are automatically focused during their initial map.
# A compositor rule is the only mechanism early enough to reject that focus
# request, so the selected word remains owned by the source Firefox window.
kwriteconfig6 --file kwinrulesrc --group "${rule_id}" \
	--key Description "Keep focus on the source window for DictAI definitions"
kwriteconfig6 --file kwinrulesrc --group "${rule_id}" \
	--key title "[DICTAI_POPUP|"
kwriteconfig6 --file kwinrulesrc --group "${rule_id}" \
	--key titlematch 2
kwriteconfig6 --file kwinrulesrc --group "${rule_id}" \
	--key acceptfocus false
kwriteconfig6 --file kwinrulesrc --group "${rule_id}" \
	--key acceptfocusrule 2

existing_rules="$(
	kreadconfig6 --file kwinrulesrc --group General --key rules
)"
case ",${existing_rules}," in
*",${rule_id},"*) ;;
*)
	if [[ -n "${existing_rules}" ]]; then
		updated_rules="${existing_rules},${rule_id}"
	else
		updated_rules="${rule_id}"
	fi
	kwriteconfig6 --file kwinrulesrc --group General \
		--key rules "${updated_rules}"
	IFS=',' read -r -a rule_entries <<<"${updated_rules}"
	kwriteconfig6 --file kwinrulesrc --group General \
		--key count "${#rule_entries[@]}"
	;;
esac

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
