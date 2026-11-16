[ -f ~/.bash_aliases ] && . ~/.bash_aliases

computer() {
  # route through agents
  agents computer "$@"
}
