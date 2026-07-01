# Hướng Dẫn Triển Khai MCP Server Lên SAP BTP Cloud Foundry (SSE Mode)

Tài liệu này đóng gói toàn bộ quy trình, kiến trúc và mã nguồn mẫu để bạn có thể chuyển đổi **bất kỳ MCP Server (stdio) nào** thành một dịch vụ HTTP Server Event (SSE) chạy trên SAP BTP Cloud Foundry. Cách tiếp cận này giúp bạn có một endpoint duy nhất trên Cloud mà mọi thành viên trong team đều có thể kết nối dễ dàng.

## Kiến Trúc Hệ Thống

```mermaid
graph LR
    A[Client IDE\n(Claude/Cursor/Gemini)] -->|stdio| B(npx supergateway)
    B -->|HTTP GET /sse\nHTTP POST /messages| C[BTP Cloud Foundry\nNode.js Express App]
    C -->|SSEServerTransport| D[MCP Server Logic]
```

1. **Client (IDE)** giao tiếp qua `stdio` với bộ proxy nội bộ là `supergateway`.
2. **Supergateway** kết nối lên Cloud Foundry qua HTTP SSE (`/sse` và `/messages`).
3. **Ứng dụng trên BTP Cloud Foundry** đóng vai trò cầu nối, đón nhận SSE request và truyền vào cho instance `McpServer` của bạn.

> [!IMPORTANT]
> **Vấn Đề Kỹ Thuật Quan Trọng Đã Được Xử Lý:**
> Trong quá trình xây dựng wrapper, bạn **phải** tạo một instance `McpServer` mới cho mỗi kết nối (mỗi `sessionId`). Bộ SDK MCP không cho phép nhiều luồng transport gán vào chung 1 server. Hơn nữa, `SSEServerTransport` sẽ tự sinh ra `sessionId` nội bộ, do đó ta phải lấy `transport.sessionId` thay vì tự tạo.

---

## Bước 1: Cập Nhật Mã Nguồn Ứng Dụng (Node.js)

Dưới đây là đoạn mã "Wrapper chuẩn" bằng Express.js bạn có thể chèn vào bất kỳ ứng dụng MCP nào để biến nó thành SSE Server.

Yêu cầu cài đặt thư viện:
```bash
npm install express @modelcontextprotocol/sdk
```

Tạo file `server.mjs` (hoặc chèn vào file hiện tại):

```javascript
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

// Hàm đóng gói logic tạo MCP Server (Thay bằng logic của bạn)
// Bắt buộc phải là dạng Factory (tạo instance mới cho mỗi kết nối)
function createMcpServer() {
  const server = new Server(
    { name: 'my-custom-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // Đăng ký các công cụ ở đây...
  server.registerTool('ping', { title: 'Ping', inputSchema: {} }, async () => {
    return { content: [{ type: 'text', text: 'pong' }] };
  });

  return server;
}

const app = express();

// Sử dụng Map để lưu trữ các luồng kết nối theo Session ID
const transports = new Map();

// Endpoint 1: Khởi tạo luồng SSE
app.get('/sse', async (req, res) => {
  // Tạo transport
  const transport = new SSEServerTransport('/messages', res);
  
  // CRITICAL: Lấy sessionId do chính SDK sinh ra, KHÔNG tự tạo UUID
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);
  
  // Khi kết nối bị ngắt, dọn dẹp Map để tránh rò rỉ bộ nhớ
  res.on('close', () => {
    console.log(`[MCP] SSE session ${sessionId} closed`);
    transports.delete(sessionId);
  });
  
  // Tạo 1 instance MCP Server riêng cho session này
  const server = createMcpServer();
  await server.connect(transport);
});

// Endpoint 2: Nhận tin nhắn JSON-RPC từ Client
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  
  if (!transport) {
    return res.status(404).send('Session not found');
  }
  
  // Giao việc xử lý message cho SDK
  await transport.handlePostMessage(req, res);
});

// Khởi động Express
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`[MCP] Server listening on port ${port} in SSE mode.`);
});
```

---

## Bước 2: Cấu Hình Triển Khai Lên BTP (manifest.yml)

Tạo file `manifest.yml` tại thư mục gốc của project:

```yaml
---
applications:
  - name: my-custom-mcp          # Thay tên app của bạn
    memory: 512M                 # Điều chỉnh RAM tuỳ vào app
    default-route: true
    buildpacks:
      - nodejs_buildpack
    command: npm start           # Hoặc 'node server.mjs'
```

Đẩy code lên CF:
```bash
cf push
```
Sau khi hoàn tất, lấy URL của app (VD: `https://my-custom-mcp.cfapps.ap21.hana.ondemand.com`).

---

## Bước 3: Cấu Hình Cho Phía Client (Các IDE)

Tại phía máy trạm (của bạn hoặc người dùng khác), **không cần cài đặt clone repo**. Chỉ cần sử dụng cấu hình chung dưới đây cho tệp `mcp_config.json`, `claude_desktop_config.json`, v.v...

```json
{
  "mcpServers": {
    "my-remote-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "supergateway",
        "--sse",
        "https://my-custom-mcp.cfapps.ap21.hana.ondemand.com/sse"
      ]
    }
  }
}
```

> [!TIP]
> Gói `supergateway` xử lý cực kỳ mượt mà việc chuyển đổi giữa luồng `stdio` của IDE và luồng HTTP của BTP. Việc dùng `npx -y` đảm bảo máy nào cũng có thể chạy ngay lập tức mà không cần pre-install.

---

## Mở Rộng: Tích Hợp Bảo Mật (Xác Thực Bằng API Key)

BTP Cloud Foundry phơi bày endpoint công khai ra internet. Để tránh người lạ sử dụng MCP của bạn, hãy thêm Middleware kiểm tra API Key đơn giản vào trước các Route của Express:

1. **Trên BTP**, set biến môi trường: `cf set-env my-custom-mcp API_KEY "my-secret-key-123"`
2. **Trong code Express**, chèn middleware trước `app.get` và `app.post`:
   ```javascript
   const API_KEY = process.env.API_KEY;
   app.use((req, res, next) => {
     if (!API_KEY) return next();
     if (req.headers.authorization !== `Bearer ${API_KEY}`) {
       return res.status(401).send('Unauthorized');
     }
     next();
   });
   ```
3. **Bên Client config**, thêm Header vào `supergateway`:
   ```json
   "args": [
     "-y", "supergateway", 
     "--sse", "https://my-custom-mcp.../sse",
     "-h", "Authorization: Bearer my-secret-key-123"
   ]
   ```
