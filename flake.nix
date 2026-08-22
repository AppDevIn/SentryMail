{
  description = "SentryMAil - Tauri v2 + React + Rust email client with on-device Gemma triage";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Native libs Tauri's Linux WebKitGTK backend links against at build and run time.
        guiLibs = with pkgs; [
          webkitgtk_4_1
          gtk3
          cairo
          gdk-pixbuf
          glib
          pango
          atk
          librsvg
          libsoup_3
          libayatana-appindicator
          xdotool
        ];

        # Non-GUI native deps: openssl (reqwest/oauth2), libsecret+dbus (keyring crate).
        systemLibs = with pkgs; [
          openssl
          libsecret
          dbus
        ];
      in
      {
        devShells.default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            pkg-config
            cmake          # llama.cpp C++ sources, via llama-cpp-sys-2
            clang
            rustc
            cargo
            rustfmt
            clippy
            rust-analyzer
            nodejs_22

            # Standalone llama.cpp CLI, for smoke-testing a GGUF and its chat
            # template independently of the Tauri app. The app itself does NOT
            # use this - `llama-cpp-2` vendors and compiles llama.cpp in-process.
            llama-cpp
          ];

          buildInputs = guiLibs ++ systemLibs;

          # bindgen (llama-cpp-sys-2) needs libclang plus the C builtin headers.
          LIBCLANG_PATH = "${pkgs.libclang.lib}/lib";
          BINDGEN_EXTRA_CLANG_ARGS =
            "-isystem ${pkgs.libclang.lib}/lib/clang/${pkgs.lib.versions.major pkgs.libclang.version}/include"
            + " -isystem ${pkgs.glibc.dev}/include";

          shellHook = ''
            # WebKitGTK's DMABUF renderer is broken on many NixOS setups; the app
            # shows a blank white window without this.
            export WEBKIT_DISABLE_DMABUF_RENDERER=1
            export WEBKIT_DISABLE_COMPOSITING_MODE=1
            # Needed for TLS inside the webview (Gmail OAuth consent screen).
            export GIO_MODULE_DIR="${pkgs.glib-networking}/lib/gio/modules"
            echo "SentryMAil dev shell: rust $(rustc --version | cut -d' ' -f2), node $(node --version)"
          '';
        };
      });
}
