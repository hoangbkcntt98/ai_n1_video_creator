# Upload YouTube qua API

## Cần chuẩn bị

- Tài khoản Google có kênh YouTube, có quyền upload lên kênh đó.
- Google Cloud project bật **YouTube Data API v3**.
- OAuth consent screen và OAuth client loại **Web application**.
- Client ID, Client Secret và Refresh Token có scope `https://www.googleapis.com/auth/youtube.upload`.
- Python 3.9+ trên server; worker chỉ dùng thư viện chuẩn.

**API key không đủ để upload. Không dùng service account cho kênh YouTube thông thường.**

## Cấu hình Google Cloud và lấy refresh token

1. Mở Google Cloud Console: https://console.cloud.google.com/
2. Tạo/chọn project. Vào **APIs & Services → Library**, bật **YouTube Data API v3**.
3. Mở **Google Auth Platform** (hoặc OAuth consent screen). Điền tên app, email hỗ trợ và thông tin liên hệ.
4. Với app External đang ở **Testing**, thêm email Google của bạn vào **Test users**.
5. Trong phần **Data Access**, thêm scope:

   ```text
   https://www.googleapis.com/auth/youtube.upload
   ```

6. Tạo OAuth Client ID loại **Web application**. Thêm Authorized redirect URI chính xác:

   ```text
   https://developers.google.com/oauthplayground
   ```

7. Mở https://developers.google.com/oauthplayground
8. Bấm biểu tượng cài đặt, bật **Use your own OAuth credentials**. Nhập Client ID và Client Secret từ project vừa tạo. Chọn access type **Offline**, yêu cầu consent nếu có tùy chọn.
9. Nhập scope `https://www.googleapis.com/auth/youtube.upload`, bấm **Authorize APIs**. Đăng nhập đúng Google account và chọn đúng kênh nếu Google hỏi.
10. Ở bước 2, bấm **Exchange authorization code for tokens**. Sao chép **Refresh token**, không phải Access token.
11. Điền `.env.local`:

    ```env
    YOUTUBE_CLIENT_ID=your-client-id.apps.googleusercontent.com
    YOUTUBE_CLIENT_SECRET=your-client-secret
    YOUTUBE_REFRESH_TOKEN=your-refresh-token
    ```

12. Nếu code chưa được build, đợi pipeline/upload hiện tại kết thúc rồi chạy `npx next build`. Sau đó restart app:

    ```bash
    pm2 restart video-creator --update-env
    ```

Ứng dụng không cần OAuth callback riêng: bước cấp quyền thực hiện qua OAuth Playground bằng client của bạn. Không dùng credentials mặc định của Playground cho token chạy lâu dài.

## Sửa lỗi `invalid_grant`

Lỗi này ở bước Google OAuth đổi refresh token lấy access token, không phải lỗi quota upload.
Thông báo cũ của worker ghi `YouTube API HTTP 400 (invalid_grant)`; worker mới ghi
`Google OAuth HTTP 400 (invalid_grant)` cùng hướng dẫn khôi phục.

Google đã từ chối refresh token. Chỉ mã lỗi này không đủ để xác định nguyên nhân cụ thể:
token có thể hết hạn, bị thu hồi hoặc không thuộc OAuth client đang cấu hình.

1. Kiểm tra **Google Auth Platform → Audience**. Với app **External / Testing** dùng scope YouTube,
   refresh token hết hạn sau **7 ngày**. Nếu cần chạy lâu dài, chuyển sang **In production**
   và hoàn tất verification nếu Google yêu cầu trước khi cấp token mới. Đổi trạng thái không khôi phục token đã hỏng.
2. Làm lại bước 7–10 phía trên. Trong OAuth Playground, phải bật **Use your own OAuth credentials**,
   dùng đúng cặp `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` trong `.env.local`, chọn **Offline**
   và scope `https://www.googleapis.com/auth/youtube.upload`.
   Không dùng credentials mặc định của Playground cho token chạy lâu dài.
3. Đăng nhập tài khoản/kênh cần nhận video, cấp quyền lại, rồi lấy **Refresh token** mới.
   Không dùng Authorization code hoặc Access token thay cho Refresh token.
4. Thay `YOUTUBE_REFRESH_TOKEN` trong `.env.local`. Nếu đổi OAuth client, cập nhật cả ba biến cùng nhau.
   Không gửi token hay Client Secret vào chat/log.
5. Đợi run hiện tại kết thúc, chạy `pm2 restart video-creator --update-env` để app nạp lại cấu hình.
   Nếu credentials còn được khai báo trong cấu hình PM2 hoặc môi trường shell, cập nhật nguồn đó:
   biến môi trường có sẵn được ưu tiên hơn `.env.local`.
6. Thử upload lại. Không retry liên tục khi token chưa được thay; retry không sửa được `invalid_grant`.
   Nếu lỗi xảy ra khi đang upload do worker cần refresh token, kiểm tra YouTube Studio trước để tránh đăng trùng.

## Upload trong app

1. Dashboard → **Run History** → mở run đã tạo video, hoặc **Grammar Patterns** → **Video / Publish**.
2. Chỉnh **Title** và **Caption / Description** ngay bên dưới video. Facebook và YouTube dùng chung nội dung đang chỉnh, không cần Save trước khi upload. Với YouTube, title tối đa 100 ký tự; description tối đa 5000 byte UTF-8. App báo lỗi nếu vượt giới hạn, không tự cắt nội dung.
3. Bấm **Upload to YouTube** cạnh các nút Facebook để mở tùy chọn ngay tại video, không chuyển trang.
4. Chọn **Private**, **Unlisted** hoặc **Public**. Mặc định **Private**.
5. Chọn đúng audience **Made for kids** và khai báo **realistic altered or synthetic content** theo nội dung thực tế. Không phải mọi ảnh AI/TTS đều mặc định cần khai báo giống nhau; đọc hướng dẫn YouTube.
6. Bấm **Confirm YouTube Upload**, xác nhận. App tạo run `youtube_publish`; xem tiến độ/log ngay trong tùy chọn upload hoặc Dashboard → Run History.
7. Upload thành công lưu YouTube video ID, thời gian upload và visibility YouTube trả về. Mở lại **Upload to YouTube** tại video để xem thông tin và link **View on YouTube**. Upload lại sẽ tạo video YouTube mới; app cảnh báo trước khi xác nhận.

Không còn màn YouTube riêng. Đường dẫn `/youtube` cũ chuyển về Dashboard. Trường lịch bên cạnh video chỉ áp dụng cho Facebook, không hẹn giờ công khai video YouTube.

## Tự động upload sau Daily Pipeline Schedule

1. Dashboard → **AUTOMATION → Pipeline Schedule**. Chọn lịch hằng ngày hoặc khoảng giờ theo [hướng dẫn lịch tạo video](PIPELINE_SCHEDULE.vi.md).
2. Bật **Publish to YouTube after video creation**.
3. Chọn visibility, audience và khai báo nội dung. Mặc định **Private**; chọn **Public** nếu muốn công khai sau upload. Những khai báo này áp dụng cho mọi video được tạo bởi lịch.
4. Bấm **Save Schedule** và xác nhận quyền tự động upload. Khi lịch đang bật, server yêu cầu đủ ba biến OAuth trước khi cho lưu.

- Facebook và YouTube bật/tắt độc lập. Nếu bật cả hai, Facebook upload trước; YouTube chờ Facebook kết thúc. Facebook lỗi vẫn cho phép thử YouTube.
- Dùng title và caption được pipeline tạo ra. Nội dung vượt giới hạn YouTube báo lỗi, không tự cắt.
- Mỗi upload có run riêng trong **Run History**. Lỗi tự động upload cũng ghi ở **Last error** của lịch; video đã tạo thành công vẫn giữ trạng thái success.
- Lựa chọn upload được lưu theo từng run khi bắt đầu tạo video. Sửa/xóa lịch ảnh hưởng lần chạy tiếp theo, không hủy upload đã được run hiện tại nhận.
- Khi app restart, ý định upload chưa được nhận xử lý được khôi phục. Mỗi ý định chỉ được nhận một lần để tránh đăng trùng. Nếu app dừng đúng lúc đã nhận xử lý nhưng chưa tạo upload run, kiểm tra Run History và kênh trước khi upload thủ công; không tự retry trường hợp không rõ kết quả.

Thời gian upload không phải thời gian công khai. YouTube có thể còn xử lý video sau khi API nhận file.

## Giới hạn và vận hành

- Hỗ trợ upload thủ công và tự động sau Daily Schedule. Chưa tích hợp Quota Schedule hoặc hẹn giờ công khai bằng YouTube `publishAt`.
- App chỉ cho một pipeline/upload hoạt động đồng thời. Nếu đang có run khác, upload trả lỗi chờ.
- Worker Python chạy detached: đóng tab không hủy upload. App có thể khôi phục kết quả từ log sau restart; nếu chính worker bị dừng, không tự upload lại.
- Upload dùng resumable chunks, kiểm tra offset trước khi retry lỗi mạng để tránh gửi lại toàn bộ video.
- Trước khi retry run lỗi, kiểm tra YouTube Studio: có thể YouTube đã nhận video nhưng app chưa ghi được kết quả.
- `CODEX_QUOTA_ACCOUNT` không chọn kênh YouTube. Kênh nhận upload được quyết định bởi tài khoản/kênh đã cấp OAuth refresh token.
- Project API chưa được YouTube kiểm tra, tạo sau **28/07/2020**, bị giới hạn video upload qua `videos.insert` ở chế độ private. Muốn bỏ giới hạn cần quy trình API compliance audit của YouTube. OAuth verification và YouTube API audit là hai việc khác nhau.
- Với OAuth External còn **Testing**, refresh token có scope YouTube thường hết hạn sau 7 ngày. Khi dùng lâu dài, xem xét chuyển app sang Production và hoàn tất verification nếu Google yêu cầu.
- Có quota API và giới hạn upload của kênh. Khi gặp `quotaExceeded`, `uploadLimitExceeded`, dừng và kiểm tra project/channel, không retry liên tục.
- Khi gặp `invalid_grant`, cấp quyền lại để lấy refresh token mới.
- Token chỉ nằm trong môi trường server, không trả về browser, không ghi vào command line/log. Không commit `.env.local`; không gửi Client Secret hay Refresh Token trong chat. Nếu lộ token, thu hồi quyền ứng dụng trong Google Account và cấp lại.

## Tài liệu chính thức

- Upload API: https://developers.google.com/youtube/v3/docs/videos/insert
- Video metadata: https://developers.google.com/youtube/v3/docs/videos
- Resumable upload: https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
- OAuth server-side: https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps
- Refresh token expiration: https://developers.google.com/identity/protocols/oauth2#expiration
- OAuth Playground: https://developers.google.com/oauthplayground
- Altered/synthetic content: https://support.google.com/youtube/answer/14328491
