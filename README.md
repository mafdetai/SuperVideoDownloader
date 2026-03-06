# supervideodownloaderforchrome

一个用于在你**拥有权利或明确授权**的前提下下载视频的小型 Chrome 扩展。  
A small Chrome extension that helps download video **only when you have the rights or explicit permission** to do so.

## Important Notice / 重要提示 (Please Read)
- 本项目仅供学习使用，并仅用于个人用途。  
  This project is provided for learning and personal use.
- 你只能下载你拥有、创建或已明确授权的内容。  
  You must only download content that you own, created, or have explicit permission to download.
- 不要用本工具绕过访问控制或平台规则。  
  Do not use this tool to bypass access controls or platform rules.
- 你需要自行遵守相关法律及平台服务条款。  
  You are responsible for complying with all applicable laws and the terms of service of the platforms you use.
- 平台账号不提供，请自行准备并登录。  
  Platform accounts are not provided; please prepare and log in with your own.
- 作者不鼓励或支持任何形式的侵权行为。  
  The author does not encourage or endorse copyright infringement.

## What It Does / 功能
- 在目标页面点击扩展按钮，尝试解析视频链接并下载。  
  On a supported page, click the extension button to try to resolve a video URL and download it.

## Supported Sites / 支持范围
- 视频按钮支持 X/Twitter（具体帖子页）、小红书（`/explore/`），以及带直链 `<video>` 的通用网页；Instagram 视频不支持。  
  Video button supports X/Twitter (post pages), Xiaohongshu (`/explore/`), and generic pages with direct `<video>` MP4; Instagram video is not supported.
- 图片按钮支持 X/Twitter 帖子、Instagram 帖子、小红书 `explore` 帖子；列表/主页会进入分批模式。  
  Image buttons support X/Twitter posts, Instagram post pages, and Xiaohongshu `explore` posts; feeds/profiles use batch mode.

## Permissions / 权限说明
- `activeTab`/`tabs`：读取当前页 URL 与标题信息。  
  Read the current tab URL and metadata.
- `scripting`：注入脚本读取页面媒体信息。  
  Inject scripts to read media info from the page.
- `downloads`：触发下载保存文件。  
  Start downloads and save files.
- `storage`：保存分批下载进度与去重状态。  
  Persist batch progress and dedupe state.
- `webRequest`：用于页面侧兜底抓取媒体请求（如部分站点）。  
  Used for page-side fallback capture of media requests (on some sites).

## Default Config / 默认配置（可选）
- 若你改乱了配置，可把下面默认值复制回文件对应位置：  
  If you changed configs, copy the defaults below back into the indicated files:
- `popup.js` 顶部常量区：  
  `popup.js` top constants section:
  ```js
  const BATCH_SIZE = 20;
  const BATCH_STATE_TTL_MS = 0;
  const INS_MIN_VIDEO_BYTES = 150 * 1024;
  ```
- `background.js` 顶部常量区：  
  `background.js` top constants section:
  ```js
  const IMAGE_MIN_BYTES = 10 * 1024;
  const MAX_IMAGE_DOWNLOADS = 20;
  const CONVERT_WEBP_TO_JPG = false;
  const INS_MIN_VIDEO_BYTES = 150 * 1024;
  const INSTAGRAM_NET_URL_TTL_MS = 10 * 60 * 1000;
  const INSTAGRAM_NET_URL_MAX_PER_TAB = 120;
  ```

## Release Folder / 发布版目录
- GitHub 发布建议以 `twitter_video_dl_github_20260306` 作为仓库根目录。  
  For GitHub release, use `twitter_video_dl_github_20260306` as the repo root.

## Troubleshooting / 常见问题
- **无法下载**：先确认登录与页面加载完成，必要时先播放视频。  
  Ensure you are logged in and the page is fully loaded; play video first if needed.
- **提示未检测到资源**：确认是否在具体帖子页而非列表页。  
  Ensure you are on a specific post page, not a feed/profile.
- **只下到一部分**：列表页会分批下载，按提示继续即可。  
  Feeds are downloaded in batches; use the Continue prompt.

## External Services / 外部依赖
- 本项目可能使用第三方解析服务获取公开视频链接，服务可用性与费用由第三方决定。  
  This project may use third-party parsing services to obtain public media URLs; availability and pricing are controlled by those providers.

## Acknowledgements / 特别鸣谢
- 感谢公开可用的第三方解析服务与社区资源。  
  Thanks to publicly available parsing services and community resources.

## How To Load (Unpacked) / 如何加载未打包扩展
1. 打开 Chrome 或 Edge 并访问扩展页：  
   - Chrome: `chrome://extensions/`  
   - Edge: `edge://extensions/`  
   Open Chrome or Edge and go to the extensions page:
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
2. 开启 **Developer mode / 开发者模式**。  
   Enable **Developer mode**.
3. 点击 **Load unpacked / 加载已解压的扩展程序**。  
   Click **Load unpacked**.
4. 选择项目根目录（包含 `manifest.json` 的目录）。  
   Select the project root (the folder that contains `manifest.json`).

## Usage / 使用方法
1. 访问目标视频页面（如 `https://x.com/<user>/status/<id>`）。  
   Visit a supported page (e.g., `https://x.com/<user>/status/<id>`).
2. 点击扩展图标。  
   Click the extension icon.
3. 点击“下载 / Download”。  
   Click “Download”.

## Tutorial / 图文教程
- 中文图文教程：`docs/usage_zh.md`
- English tutorial: `docs/usage_en.md`

## Disclaimer / 免责声明
本项目按“原样”提供，不提供任何保证。作者不对任何误用或法律问题负责。  
This project is provided “as is” without warranty of any kind. The author is not responsible for any misuse or legal issues arising from use of this project.

## License
MIT
