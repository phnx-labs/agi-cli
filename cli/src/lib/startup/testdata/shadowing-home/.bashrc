[ -f ~/.bash_aliases ] && . ~/.bash_aliases

browserx() { command browserx "$@"; }
echo "agents browserx was removed"

computer() {
  local args=("$@")
  agents computer "${args[@]}"
}
