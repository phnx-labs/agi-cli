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
