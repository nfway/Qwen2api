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
  const reader = response.body!.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  
  let buffer = "";
  let previousContent = "";
  
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          let lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            
            const data = line.slice(6);
            if (data === "[DONE]") {
              controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
              continue;
            }

            try {
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
                  previousContent = currentContent;
                }
              } else if (choice?.delta?.role) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
              }
            } catch (e) {
              console.error("Skipping invalid JSON:", line);
            }
          }
        }

        // 处理剩余buffer（仅处理有效数据）
        if (buffer.startsWith("data: ")) {
          const data = buffer.slice(6);
          try {
            if (data !== "[DONE]") {
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
            console.error("Failed to parse remaining buffer:", buffer);
          }
        }
        
        controller.close();
      } catch (e) {
        console.error("Stream error:", e);
        controller.error(e);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
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
