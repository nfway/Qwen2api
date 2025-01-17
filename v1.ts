import { serve } from "https://deno.land/std/http/server.ts";

const QWEN_BASE_URL = "https://chat.qwenlm.ai";

// 接口定义
interface MessageContent {
  type: string;
  text?: string;
  image?: string;
  image_url?: {
    url: string;
  };
}

interface Message {
  role: string;
  content: MessageContent[] | string;
}

// 流式响应相关接口
interface DeltaChoice {
  delta: {
    content?: string;
    role?: string;
  };
  index: number;
  finish_reason: string | null;
}

interface StreamResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: DeltaChoice[];
}

/**
 * 获取两个字符串之间的增量内容
 */
function getIncrementalContent(previous: string, current: string): string {
  let i = 0;
  while (i < previous.length && i < current.length && previous[i] === current[i]) {
    i++;
  }
  return current.slice(i);
}

/**
 * 处理流式响应的核心函数
 */
async function streamResponse(response: Response) {
  // 获取响应体的读取器
  const reader = response.body!.getReader();
  // 创建文本编码器和解码器
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  
  // 用于存储未处理完的数据片段
  let buffer = "";
  // 用于记录上一次的完整内容，用于计算增量
  let previousContent = "";
  
  // 创建可读流
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          // 读取数据块
          const { done, value } = await reader.read();
          if (done) break;
          
          // 将二进制数据解码为文本
          buffer += decoder.decode(value, { stream: true });
          // 按换行符分割数据
          const lines = buffer.split("\n");
          // 保存最后一个可能不完整的行
          buffer = lines.pop() || "";
          
          for (const line of lines) {
            // 跳过空行
            if (line.trim() === "") continue;
            // 跳过非数据行
            if (!line.startsWith("data: ")) continue;
            
            // 提取数据部分
            const data = line.slice(6);
            // 处理流结束标记
            if (data === "[DONE]") {
              controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
              continue;
            }
            
            try {
              // 解析 JSON 数据
              const parsed = JSON.parse(data) as StreamResponse;
              const choice = parsed.choices[0];
              
              if (choice?.delta?.content) {
                // 处理内容更新
                const currentContent = choice.delta.content;
                // 计算真正的增量内容
                const incrementalContent = getIncrementalContent(previousContent, currentContent);
                
                if (incrementalContent) {
                  // 构造新的输出对象，只包含增量内容
                  const newOutput: StreamResponse = {
                    ...parsed,
                    choices: [{
                      ...choice,
                      delta: { content: incrementalContent }
                    }]
                  };
                  // 将增量内容编码并发送
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(newOutput)}\n\n`));
                  // 更新前一次的内容
                  previousContent = currentContent;
                }
              } else if (choice?.delta?.role) {
                // 对于角色信息，直接转发不需要处理增量
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
              }
            } catch (e) {
              console.error("Failed to parse JSON:", e);
            }
          }
        }
        
        // 处理缓冲区中可能剩余的最后一块数据
        if (buffer) {
          try {
            const data = buffer.replace(/^data: /, "");
            if (data !== "[DONE]") {
              // 解析并处理最后的数据块
              const parsed = JSON.parse(data) as StreamResponse;
              const choice = parsed.choices[0];
              
              if (choice?.delta?.content) {
                const currentContent = choice.delta.content;
                const incrementalContent = getIncrementalContent(previousContent, currentContent);
                
                if (incrementalContent) {
                  const newOutput: StreamResponse = {
                    ...parsed,
                    choices: [{
                      ...choice,
                      delta: { content: incrementalContent }
                    }]
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(newOutput)}\n\n`));
                }
              }
            }
          } catch (e) {
            console.error("Failed to parse remaining buffer:", e);
          }
        }
        
        // 关闭控制器
        controller.close();
      } catch (e) {
        // 发生错误时通知控制器
        controller.error(e);
      }
    },
  });

  // 返回新的流式响应，设置适当的响应头
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",  // 指定为服务器发送事件流
      "Cache-Control": "no-cache",          // 禁用缓存
      "Connection": "keep-alive",           // 保持连接
    },
  });
}

/**
 * 将base64图片上传到API
 */
async function uploadImage(base64Image: string, headers: Headers): Promise<string> {
  // 从base64字符串中提取实际的数据部分
  const base64Data = base64Image.split(',')[1] || base64Image;
  
  // 将base64解码为二进制数据
  const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
  
  // 创建文件上传请求
  const formData = new FormData();
  const blob = new Blob([binaryData]);
  formData.append('file', blob, 'image.png');
  
  // 创建新的headers，复制认证相关的header
  const uploadHeaders = new Headers();
  const authHeader = headers.get('Authorization');
  if (authHeader) {
    uploadHeaders.set('Authorization', authHeader);
  }
  
  const uploadResponse = await fetch(`${QWEN_BASE_URL}/api/v1/files/`, {
    method: 'POST',
    headers: uploadHeaders,
    body: formData,
  });
  
  if (!uploadResponse.ok) {
    throw new Error(`Failed to upload image: ${uploadResponse.statusText}`);
  }
  
  const result = await uploadResponse.json();
  return result.id;
}

/**
 * 转换消息格式，处理图片上传
 */
async function convertMessages(messages: Message[], headers: Headers): Promise<Message[]> {
  const convertedMessages: Message[] = [];
  
  for (const message of messages) {
    const convertedMessage: Message = { ...message };
    
    if (Array.isArray(message.content)) {
      const convertedContent: MessageContent[] = [];
      
      for (const content of message.content) {
        if (content.type === 'image_url' && content.image_url?.url?.startsWith('data:image')) {
          // 上传图片并获取文件ID
          const fileId = await uploadImage(content.image_url.url, headers);
          convertedContent.push({
            type: 'image',
            image: fileId
          });
        } else {
          convertedContent.push(content);
        }
      }
      
      convertedMessage.content = convertedContent;
    }
    
    convertedMessages.push(convertedMessage);
  }
  
  return convertedMessages;
}

/**
 * 处理传入请求的主函数
 */
async function handleRequest(request: Request) {
  const url = new URL(request.url);
  const targetUrl = new URL(url.pathname + url.search, QWEN_BASE_URL);
  
  let body;
  if (request.method !== "GET") {
    body = await request.json();
    
    // 如果是聊天完成请求，且包含消息数组，进行消息转换
    if (url.pathname === "/api/chat/completions" && Array.isArray(body?.messages)) {
      try {
        body.messages = await convertMessages(body.messages, request.headers);
      } catch (error) {
        console.error("Error converting messages:", error);
        return new Response(JSON.stringify({ error: "Failed to process images" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
  }
  
  const requestInit: RequestInit = {
    method: request.method,
    headers: new Headers(request.headers),
  };

  if (body) {
    requestInit.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(targetUrl.toString(), requestInit);
    
    if (url.pathname === "/api/chat/completions" && body?.stream === true) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        return await streamResponse(response);
      }
    }

    return response;
  } catch (error) {
    console.error("Error forwarding request:", error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

console.log("Server starting on port 80...");
await serve(handleRequest, { port: 80 });
