# A real tab shell with zero or more live processes, including a wrapper hop.
# The test supplies a copy of sleep named claude so ps sees the agent executable.
for ((i = 0; i < $2; i++)); do
  bash -c '
    if [[ "$2" == nested ]]; then echo "$$"; fi
    "$1" 600 & echo "$!"
    wait
    if [[ "$2" == nested ]]; then sleep 600 & wait; fi
  ' hold "$1" "$3" &
done
read -r _
wait
