# Lịch tạo video trên Dashboard

Trong **AUTOMATION → Pipeline Schedule**, chọn:

- **Daily (1 video)**: lịch cũ, mỗi ngày tạo một video vào giờ đã chọn.
- **Repeat every N hours**: mỗi đợt tạo số video chỉ định, lặp theo số giờ tính từ mốc bắt đầu.

## Ví dụ: cứ 5 giờ tạo 4 video

1. Chọn **Repeat every N hours**.
2. Nhập **Start date and time**: `12/09/2026 15:00:00`.
3. Nhập **Repeat every (hours)**: `5`.
4. Nhập **Videos per batch**: `4`.
5. Chọn **Timezone**, ví dụ `Asia/Ho_Chi_Minh` nếu mốc 15:00 là giờ Việt Nam.
6. Chọn tùy chọn tạo lại và upload Facebook/YouTube nếu cần.
7. Bật **Enable schedule**, bấm **Save Schedule**.

Các mốc lần lượt là **12/09/2026 15:00**, **12/09/2026 20:00**,
**13/09/2026 01:00**, **13/09/2026 06:00** trong múi giờ ví dụ trên.
Mỗi đợt tạo lần lượt 4 video; không phải tạo một video mỗi 5 giờ.
Mốc lặp tính từ giờ bắt đầu, không tính từ lúc video cuối cùng hoàn thành.

## Quy tắc vận hành

- Khoảng lặp: số nguyên từ **1 đến 8760 giờ**. Số video mỗi đợt: **1 đến 100**.
- Thời điểm nhập thuộc múi giờ trong form, không phụ thuộc múi giờ server/browser.
  Ở nơi có DST, giờ địa phương không tồn tại bị từ chối; giờ bị lặp chọn lần theo giờ tiêu chuẩn.
  Sau mốc bắt đầu, khoảng lặp luôn tính theo số giờ thực tế đã trôi qua.
- Scheduler kiểm tra mỗi **10 giây** khi app chạy. Không cam kết khởi chạy đúng từng giây.
- Chỉ một pipeline/upload chạy tại một thời điểm. Mỗi video hoàn tất upload đã chọn
  (Facebook trước, YouTube sau) rồi hàng đợi mới nhận video tiếp theo.
- Server bận: giữ hàng đợi hiện tại. Server offline hoặc đợt chạy quá lâu:
  hoàn tất hàng đợi còn lại, sau đó chỉ chạy **mốc gần nhất đã đến hạn**;
  bỏ các mốc cũ hơn, không dồn toàn bộ lịch bị lỡ.
- Hàng đợi lưu trong PostgreSQL; mỗi công việc gắn tối đa một generation run.
  Restart tiếp tục công việc chưa bắt đầu, không tự tạo lại công việc đã có run.
- Generation lỗi: hủy video còn lại trong cùng đợt để tránh lặp vô hạn cùng mẫu ngữ pháp lỗi.
  Đợt theo lịch tiếp theo vẫn có thể chạy. Xem **Last error** và **Run History**.
  Vì vậy số lượng cấu hình là số video dự kiến, không bảo đảm đủ khi pipeline lỗi.
- Upload lỗi không biến video đã tạo thành generation lỗi. Các video tiếp theo vẫn được tạo.
- **Save Schedule**, tắt hoặc xóa lịch sẽ hủy các video chưa bắt đầu của cấu hình cũ.
  Video đang chạy và upload đã được nhận vẫn tiếp tục. Lưu lại cùng mốc/khoảng lặp
  không chạy trùng đợt đã nhận; đổi mốc/khoảng lặp tạo lịch mới.
- Tùy chọn YouTube vẫn cần OAuth hợp lệ và xác nhận visibility/audience/content.
  Tạo nhiều video không tự sửa được lỗi token hoặc quota.

## Cập nhật ứng dụng

Schema mới được thêm tự động khi app khởi động; migration tương ứng là
`db/004_interval_schedule.sql`. Lịch hằng ngày đang có giữ chế độ `daily`, một video mỗi ngày.
Không cần sửa `.env.local` để dùng lịch interval.

Sau khi kiểm tra và đợi công việc hiện tại hoàn tất, build/restart theo quy trình triển khai của dự án.
