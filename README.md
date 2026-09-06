 # Video Creator
 
 Web application tạo và quản lý video JLPT N1, upload lên Facebook Reels.
 
 ## Tính năng
 
 - Dashboard quản lý video và pipeline runs
 - Tạo pipeline video từ grammar patterns JLPT N1
 - Theo dõi log Python realtime
 - Upload video lên Facebook
 - Upload YouTube qua OAuth API, chọn visibility và theo dõi run. Hướng dẫn: [YouTube setup](docs/YOUTUBE_SETUP.vi.md).
 - Quản lý grammar patterns với trạng thái
 
 ## Tech Stack
 
 - **Framework**: Next.js 16 (App Router)
 - **Database**: PostgreSQL
 - **Deployment**: PM2, Nginx reverse proxy
 - **External**: Facebook Graph API, LLM API, TTS
 
 ## Cài đặt
 
 ### Prerequisites
 
 - Node.js 22+
 - PostgreSQL database
 - PM2 (`npm install -g pm2`)
 - Python 3 với các dependencies cho JLPT N1 pipeline
 
 ### Environment Variables
 
 Tạo file `.env.local` với các biến:
 
 ```env
 # LLM
 LLM_BASE_URL=http://host:port/v1
 LLM_API_KEY=your-llm-api-key
 LLM_MODEL=cx/gpt-5.6-terra
 LLM_TEMPERATURE=0.7
 LLM_MAX_TOKENS=2000
 LLM_TIMEOUT=120
 
 # IMAGE
 IMAGE_BASE_URL=http://host:port/v1
 IMAGE_API_KEY=your-image-api-key
 IMAGE_MODEL=cx/gpt-5.5-image
 IMAGE_SIZE=1024x1024
 IMAGE_TIMEOUT=600
 
 # FACEBOOK
 FACEBOOK_PAGE_ID=your-page-id
 FACEBOOK_PAGE_TOKEN=your-page-token
 FACEBOOK_AUTO_PUBLISH=false
 
 # DATABASE
 DATABASE_URL=postgresql://user:password@host:5432/dbname
 
 # PATHS
 DATA_DIR=/mnt/openclaw-data/openclaw
 OUTPUT_DIR=/mnt/openclaw-data/openclaw/outputs
 WORK_DIR=/home/opc/.openclaw/workspace/skills/jlpt-n1
 LOG_DIR=/mnt/openclaw-data/openclaw
 
 # PIPELINE
 PIPELINE_SKIP_IMAGE_GENERATION=false
 PIPELINE_SKIP_PUBLISH=false
 PIPELINE_LOG_LEVEL=INFO
 
 # TTS
 TTS_PROVIDER=edge
 TTS_VOICE=ja-JP-NanamiNeural
 
 # Optional: Custom skill directory
 JLPT_N1_SKILL_DIR=/path/to/jlpt-n1/skill
 ```
 
 ### Install & Build
 
 ```bash
 npm install
 npm run build
 ```
 
 ### Run với PM2
 
 ```bash
 pm2 start "npm run start" --name video-creator --cwd /home/opc/video-creator
 pm2 save
 ```
 
 App chạy tại: `http://127.0.0.1:3002/video-creator`
 
 ## Nginx Configuration
 
 Thêm vào Nginx config:
 
 ```nginx
 location = /video-creator {
     proxy_pass http://127.0.0.1:3002;
     proxy_http_version 1.1;
     proxy_set_header Host $host;
     proxy_set_header X-Real-IP $remote_addr;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header X-Forwarded-Proto $scheme;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     client_max_body_size 850M;
     proxy_request_buffering off;
 }
 
 location /video-creator/ {
     proxy_pass http://127.0.0.1:3002;
     # ... same headers as above
 }
 ```
 
 ## Cấu trúc Project
 
 ```
 video-creator/
 ├── src/
 │   ├── app/
 │   │   ├── api/           # API routes
 │   │   │   ├── patterns/  # Grammar patterns API
 │   │   │   ├── runs/      # Pipeline runs API
 │   │   │   │   └── [id]/log/  # Run log API
 │   │   │   └── videos/    # Videos API
 │   │   ├── patterns/      # Grammar patterns list page
 │   │   ├── layout.tsx     # Root layout
 │   │   └── page.tsx       # Dashboard page
 │   ├── components/
 │   │   ├── AppSwitcher.tsx    # App switcher dropdown
 │   │   ├── DashboardControls.tsx  # Dashboard controls
 │   │   ├── RunHistory.tsx     # Pipeline run history with logs
 │   │   └── VideoLibrary.tsx   # Video grid component
 │   ├── lib/
 │   │   ├── config.ts     # App configuration
 │   │   ├── dashboard.ts   # Dashboard data fetching
 │   │   ├── db.ts         # Database utilities
 │   │   ├── pipeline.ts    # Pipeline management
 │   │   └── video.ts       # Video utilities
 │   └── ...
 ├── .env.local            # Environment variables
 ├── next.config.ts        # Next.js config (basePath: /video-creator)
 └── package.json
 ```
 
 ## API Endpoints
 
 ### Dashboard
 
 - `GET /video-creator` - Dashboard page
 - `GET /video-creator/api/runs` - List pipeline runs
 - `POST /video-creator/api/runs` - Create new pipeline run
 - `GET /video-creator/api/runs/[id]/log` - Get run log (tail ~160KB)
 - `GET /video-creator/api/videos` - List videos
 - `GET /video-creator/api/videos/[id]` - Get video details
 - `PATCH /video-creator/api/videos/[id]` - Update video metadata
 - `POST /video-creator/api/videos/[id]/publish` - Upload to Facebook
 
 ### Grammar Patterns
 
 - `GET /video-creator/patterns` - Grammar patterns list page
 - `GET /video-creator/api/patterns` - List grammar patterns (ordered by ID ASC)
 
 ## Database Tables
 
 ### `video_creator_runs`
 
 ```sql
 CREATE TABLE video_creator_runs (
     id SERIAL PRIMARY KEY,
     action TEXT NOT NULL,
     pattern_id INTEGER,
     pattern_name TEXT,
     status TEXT NOT NULL DEFAULT 'running',
     error TEXT,
     started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     finished_at TIMESTAMPTZ,
     log_path TEXT
 );
 ```
 
 ### `grammar_patterns`
 
 Table này được tạo bởi JLPT N1 skill. App đọc từ bảng này.
 
 ## Development
 
 ```bash
 npm run dev
 ```
 
 App chạy tại: `http://localhost:3002`
 
 ## Production
 
 ```bash
 npm run build   # Build + tự động restart PM2
 ```
 
 Script `build` trong `package.json`:
 
 ```json
 "build": "next build && pm2 restart video-creator || true"
 ```
 
 ## Troubleshoot
 
 ### App lỗi 502 qua Nginx
 
 Kiểm tra:
 1. PM2 process đang online: `pm2 list`
 2. Port binding đúng: `ss -tlnp | grep 3002`
 3. Next.js bind `127.0.0.1`, không phải `0.0.0.0`:
    ```json
    "start": "next start -H 127.0.0.1 -p ${PORT:-3002}"
    ```
 
 ### Lỗi kết nối Database
 
 1. Kiểm tra `DATABASE_URL` trong `.env.local`
 2. Hostname đúng (VD: `openclaw`, không phải `localhost`)
 3. Test kết nối: `psql "$DATABASE_URL" -c "SELECT 1"`
 
 ### Lỗi "Unexpected token '<', ... is not valid JSON"
 
 API trả HTML thay vì JSON. Nguyên nhân:
 1. Client fetch path sai (thiếu basePath)
 2. API route không tồn tại
 
 Fix: Dùng `process.env.NEXT_PUBLIC_BASE_PATH` trong client fetch:
 ```typescript
 const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
 fetch(`${basePath}/api/...`);
 ```
 
 ### Log không hiện
 
 1. Kiểm tra file log trong `/mnt/openclaw-data/openclaw/video-creator/runs/`
 2. File phải có extension `.log`
 3. Run phải có `log_path` trong DB
 
 ## License
 
 Private project.
 
 ## Author
 
 OpenClaw Team

## Video Studio

Mở **Video Studio** tại `/video-creator/studio` để:

- Chọn tối đa 24 ảnh và sắp xếp thành video dọc 1080×1920.
- Có 10 audio slot; mỗi slot chọn upload hoặc tạo bằng TTS. Các audio được nối theo thứ tự (MP3/WAV/M4A/AAC/OGG/FLAC).
- Nhập tiêu đề và caption Facebook để lưu cùng video.
- Render MP4 bằng FFmpeg; video được tự động thêm vào Video Library để chỉnh sửa và đăng Facebook.


Library lưu lại ảnh/audio đã dùng và các video đã tạo để xem lại.
