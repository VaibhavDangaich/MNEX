#!/bin/zsh
# AI Agent Shell Hook
# Add this to your ~/.zshrc: source /path/to/cli_agent/hooks/zsh-hook.sh

# Get the directory where this script is located
AI_AGENT_DIR="$(dirname "$(dirname "$0")")"

# Only run if AI agent is installed
if [[ ! -f "$AI_AGENT_DIR/bin/ai.js" ]]; then
    return
fi

# Pre-command hook - captures the command before execution
__ai_preexec() {
    __AI_LAST_CMD="$1"
    __AI_CMD_START=$(date +%s)
}

# Post-command hook - captures result after execution
__ai_precmd() {
    local exit_code=$?
    
    # Skip if no command was run
    if [[ -z "$__AI_LAST_CMD" ]]; then
        return
    fi
    
    # Skip certain commands (to avoid noise)
    case "$__AI_LAST_CMD" in
        ls*|cd*|pwd|clear|exit|history*|"") 
            __AI_LAST_CMD=""
            return
            ;;
    esac
    
    # Skip if monitoring is disabled
    if [[ "$AI_MONITOR" == "off" ]]; then
        __AI_LAST_CMD=""
        return
    fi
    
    # Log the command asynchronously (don't block shell)
    (
        node "$AI_AGENT_DIR/bin/ai.js" log \
            --command "$__AI_LAST_CMD" \
            --exit-code "$exit_code" \
            --cwd "$(pwd)" \
            2>/dev/null &
    ) &>/dev/null
    
    # Reset
    __AI_LAST_CMD=""
}

# Register hooks
autoload -Uz add-zsh-hook
add-zsh-hook preexec __ai_preexec
add-zsh-hook precmd __ai_precmd

# Toggle monitoring
ai-monitor() {
    if [[ "$1" == "off" ]]; then
        export AI_MONITOR="off"
        echo "🔴 AI monitoring disabled"
    elif [[ "$1" == "on" ]]; then
        unset AI_MONITOR
        echo "🟢 AI monitoring enabled"
    else
        if [[ "$AI_MONITOR" == "off" ]]; then
            echo "Status: 🔴 OFF"
        else
            echo "Status: 🟢 ON"
        fi
        echo "Usage: ai-monitor [on|off]"
    fi
}

# Quick ask shortcut
ask() {
    ai ask "$*"
}

echo "🤖 AI Agent shell hook loaded"
