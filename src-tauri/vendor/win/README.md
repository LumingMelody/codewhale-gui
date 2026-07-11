# Windows Runtime Vendor Assets

## VCRUNTIME140.dll

- Source: Microsoft Visual C++ Runtime DLL supplied by the project maintainer for Windows installer packaging.
- Architecture: x64
- SHA-256: `76fdb83fde238226b5bebaf3392ee562e2cb7ca8d3ef75983bf5f9d6c7119644`
- Purpose: bundled with the NSIS installer so Windows machines without the VC++ runtime can load the `codewhale.exe` sidecar from the installation directory and avoid startup failure `0xC0000135`.

Do not regenerate or modify this binary in normal source changes. If the DLL is replaced, verify the architecture and update the SHA-256 above in the same change.
