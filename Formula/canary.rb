class Canary < Formula
  desc "Local code review monitor and CLI for AI-assisted development"
  homepage "https://github.com/mattzh72/canary"
  url "https://github.com/mattzh72/canary/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "7c12efc6ff6578fdc861e4598cd5b0e546eaa7f71ca01c78f3dd03062dc743be"
  license "MIT"

  depends_on "node@20"
  depends_on "pnpm"

  def install
    system "pnpm", "install", "--frozen-lockfile"
    system "pnpm", "build"

    libexec.install Dir["*"]
    libexec.install ".npmrc" if File.exist?(".npmrc")

    # Create wrapper scripts that invoke node with the built CLI entry points
    (bin/"canary").write_env_script(
      libexec/"packages/canary/dist/cli/index.js",
      PATH: "#{Formula["node@20"].opt_bin}:$PATH"
    )
    (bin/"canaryctl").write_env_script(
      libexec/"packages/canaryctl/dist/cli/index.js",
      PATH: "#{Formula["node@20"].opt_bin}:$PATH"
    )
  end

  test do
    assert_match "canaryctl", shell_output("#{bin}/canaryctl --help")
  end
end
