#!/usr/bin/env bash
# 打包并（可选）安装 Android Runner 插件
#   用法：bash build.sh          仅打包
#         bash build.sh --install 打包并安装/覆盖安装
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
OUT="$SRC/build"
VERSION="$(node -p "require('$SRC/package.json').version")"
VSIX="$SRC/android-device-runner-$VERSION.vsix"

rm -rf "$OUT"
mkdir -p "$OUT/extension"
cp "$SRC/package.json" "$SRC/extension.js" "$SRC/webview.js" "$SRC/operation.js" "$SRC/project-info.js" "$SRC/mirror.js" "$SRC/README.md" "$SRC/LICENSE" "$SRC/icon.png" "$OUT/extension/"
mkdir -p "$OUT/extension/media"
cp "$SRC"/media/* "$OUT/extension/media/"
mkdir -p "$OUT/extension/mirror"
cp "$SRC"/mirror/*.js "$OUT/extension/mirror/" 2>/dev/null || true
mkdir -p "$OUT/extension/bin"
cp "$SRC"/bin/* "$OUT/extension/bin/" 2>/dev/null || true

cat > "$OUT/extension.vsixmanifest" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="android-device-runner" Version="$VERSION" Publisher="notto-work" />
    <DisplayName>Android Device Runner</DisplayName>
    <Icon>extension/icon.png</Icon>
    <Description xml:space="preserve">在 VSCode 内一键检查设备、探测编译环境、编译、安装、启动 Android App 并投屏操作</Description>
    <Tags>android,adb,gradle,device,scrcpy,mirror</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.70.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
EOF

cat > "$OUT/[Content_Types].xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".css" ContentType="text/css" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".png" ContentType="image/png" />
  <Default Extension=".svg" ContentType="image/svg+xml" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".xml" ContentType="text/xml" />
</Types>
EOF

rm -f "$VSIX"
# 从目录内部打包，避免 [Content_Types].xml 被 shell/zip 当成通配符
( cd "$OUT" && zip -q -r -X "$VSIX" . )
echo "已生成：$VSIX"

CODE_CLI="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
if [ "${1:-}" = "--install" ]; then
  if [ -x "$CODE_CLI" ]; then
    "$CODE_CLI" --install-extension "$VSIX" --force
    echo "已安装。请在 VSCode 里执行 Developer: Reload Window 后生效。"
  else
    echo "未找到 VSCode CLI：$CODE_CLI" >&2
    echo "请手动安装：VSCode → 扩展 → ... → 从 VSIX 安装 → $VSIX" >&2
    exit 1
  fi
fi
