set -gx EDITOR nvim
function secrets
    if test -n "$argv"
        echo secrets
    end
    agents secrets $argv
end
