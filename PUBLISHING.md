# Publishing Guide

## 📦 Publishing to npm

### 1. Login to npm

```bash
npm login
```

### 2. Publish the package

```bash
# From the cli_agent directory
cd /Users/vaibhavdangaich/Desktop/cli_agent

# First time? Publish as public scoped package
npm publish --access public

# Future updates? Bump version first
npm version patch  # or minor/major
npm publish
```

### 3. Verify publication

```bash
npm info @vaibhavdangaich/ai-agent
```

---

## 🍺 Publishing to Homebrew

### Option A: Create Your Own Tap (Recommended)

#### 1. Create a new GitHub repo for your tap

Create: `https://github.com/VaibhavDangaich/homebrew-tap`

#### 2. Add the formula

```bash
# Clone your tap repo
git clone https://github.com/VaibhavDangaich/homebrew-tap.git
cd homebrew-tap

# Create Formula directory
mkdir -p Formula

# Copy the formula (update SHA256 after npm publish)
cp /Users/vaibhavdangaich/Desktop/cli_agent/homebrew/ai-agent.rb Formula/

# Get the SHA256 of the npm package
curl -sL https://registry.npmjs.org/@vaibhavdangaich/ai-agent/-/ai-agent-1.0.0.tgz | shasum -a 256

# Update the formula with the correct SHA256
# Then commit and push
git add .
git commit -m "Add ai-agent formula"
git push
```

#### 3. Users can now install via:

```bash
brew tap vaibhavdangaich/tap
brew install ai-agent
```

### Option B: Submit to Homebrew Core

This requires more review and the package must be popular. Start with your own tap first.

---

## 🚀 Final Installation Commands for Users

### Via npm (Recommended)

```bash
# Install globally
npm install -g @vaibhavdangaich/ai-agent

# Verify installation
ai --version

# Setup
ai setup
```

### Via Homebrew (after tap is set up)

```bash
# Tap and install
brew tap vaibhavdangaich/tap
brew install ai-agent

# Verify
ai --version
```

### Via npx (no install)

```bash
npx @vaibhavdangaich/ai-agent ask "hello"
```

---

## 📋 Post-Publish Checklist

- [ ] npm login
- [ ] npm publish --access public
- [ ] Get SHA256: `curl -sL https://registry.npmjs.org/@vaibhavdangaich/ai-agent/-/ai-agent-1.0.0.tgz | shasum -a 256`
- [ ] Create GitHub repo: homebrew-tap
- [ ] Update formula with SHA256
- [ ] Push formula to tap
- [ ] Test: `brew tap vaibhavdangaich/tap && brew install ai-agent`
- [ ] Update README with install instructions
