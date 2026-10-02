# A real tab shell with zero or more live processes, including a wrapper hop.
# The test supplies a copy of sleep named claude so ps sees the agent executable.
for ((i = 0; i < $2; i++)); do
  bash -c '"$1" 600 & echo "$!"; wait' hold "$1" &
done
read -r _
wait
