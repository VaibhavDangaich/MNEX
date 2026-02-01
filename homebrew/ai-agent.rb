class AiAgent < Formula
  desc "Context-aware AI CLI agent with persistent memory"
  homepage "https://github.com/VaibhavDangaich/cli_agent"
  url "https://registry.npmjs.org/@vaibhavdangaich/ai-agent/-/ai-agent-1.0.0.tgz"
  sha256 "PLACEHOLDER_SHA256"  # Will be updated after npm publish
  license "MIT"

  depends_on "node@18"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      To use ai-agent, you need to configure your API keys:

      1. Create a .env file in your home directory or project:
         cp $(brew --prefix)/lib/node_modules/@vaibhavdangaich/ai-agent/.env.example ~/.ai-agent.env

      2. Add your API keys:
         OPENAI_API_KEY=your-key-here
         # or
         GEMINI_API_KEY=your-key-here

      3. For terminal monitoring, add to ~/.zshrc:
         source $(brew --prefix)/lib/node_modules/@vaibhavdangaich/ai-agent/hooks/zsh-hook.sh

      4. Get started:
         ai ask "what am I working on?"
         ai setup  # For more setup instructions
    EOS
  end

  test do
    assert_match "AI Agent", shell_output("#{bin}/ai --help")
  end
end
