# OpenTUI third-party notices

The standalone githunk binary embeds `libopentui` from OpenTUI `0.8.1`, which
statically links FFmpeg, libwebp, zlib, Ghostty, LCMS2, stb and Wuffs. The
license and notice files below are copied verbatim from the published
`@opentui/core-linux-x64@0.8.1` platform package (every OpenTUI platform package
carries the same notices) so they can ship beside every githunk binary:

- the npm meta package and platform packages (`@xuhaojun/githunk-<os>-<arch>`)
- GitHub release archives (`githunk-<os>-<arch>.tar.gz`)
- curl/`githunk update` installations, under `githunk-assets/third-party/opentui`

`LICENSE-FFMPEG` and `FFMPEG-SOURCE.md` cover the decode-only LGPL FFmpeg build.
Do not edit the copied files. When OpenTUI is upgraded, refresh this directory
from the new platform package and re-check the file list.
