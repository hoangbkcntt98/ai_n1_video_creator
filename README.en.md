 # Video Creator
 
 Web application for creating and managing JLPT N1 videos, with Facebook Reels upload support.
 
 ## Features
 
 - Dashboard for managing videos and pipeline runs
 - Create video pipelines from JLPT N1 grammar patterns
 - Real-time Python log monitoring
 - Upload videos to Facebook
 - Manage grammar patterns with status tracking
 
 ## Tech Stack
 
 - **Framework**: Next.js 16 (App Router)
 - **Database**: PostgreSQL
 - **Deployment**: PM2, Nginx reverse proxy
 - **External**: Facebook Graph API, LLM API, TTS
 
 ## Installation
 
 ### Prerequisites
 
 - Node.js 22+
 - PostgreSQL database
 - PM2 (`npm install -g pm2`)
 - Python 3 with JLPT N1 pipeline dependencies
 
 ### Environment Variables
 
 Create `.env.local` file with:
 
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
 
 ### Run with PM2
 
 ```bash
 pm2 start "npm run start" --name video-creator --cwd /home/opc/video-creator
 pm2 save
 ```
 
 App runs at: `http://127.0.0.1:3002/video-creator`
 
 ## Nginx Configuration
 
 Add to Nginx config:
 
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
 
 ## Project Structure
 
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
 
 This table is created by JLPT N1 skill. App reads from it.
 
 ## Development
 
 ```bash
 npm run dev
 ```
 
 App runs at: `http://localhost:3002`
 
 ## Production
 
 ```bash
 npm run build   # Build + auto restart PM2
 ```
 
 Build script in `package.json`:
 
 ```json
 "build": "next build && pm2 restart video-creator || true"
 ```
 
 ## Troubleshooting
 
 ### 502 Bad Gateway via Nginx
 
 Check:
 1. PM2 process is online: `pm2 list`
 2. Port binding is correct: `ss -tlnp | grep 3002`
 3. Next.js binds `127.0.0.1`, not `0.0.0.0`:
    ```json
    "start": "next start -H 127.0.0.1 -p ${PORT:-3002}"
    ```
 
 ### Database Connection Error
 
 1. Check `DATABASE_URL` in `.env.local`
 2. Hostname is correct (e.g., `openclaw`, not `localhost`)
 3. Test connection: `psql "$DATABASE_URL" -c "SELECT 1"`
 
 ### "Unexpected token '<', ... is not valid JSON" Error
 
 API returns HTML instead of JSON. Causes:
 1. Client fetch path is wrong (missing basePath)
 2. API route doesn't exist
 
 Fix: Use `process.env.NEXT_PUBLIC_BASE_PATH` in client fetch:
 ```typescript
 const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
 fetch(`${basePath}/api/...`);
 ```
 
 ### Logs Not Showing
 
 1. Check log file in `/mnt/openclaw-data/openclaw/video-creator/runs/`
 2. File must have `.log` extension
 3. Run must have `log_path` in database
 
 ## License
 
 Private project.
 
 ## Author
 
 OpenClaw Team

## Video Studio

Open **Video Studio** at `/video-creator/studio` to combine up to 24 images with 10 audio slots where each slot can use an uploaded file or Edge TTS; slots are concatenated in order into a 1080x1920 MP4. Titles and Facebook captions are saved with the generated video and it is automatically added to the Video Library.


The Library keeps used images/audio and created videos available for replay.
