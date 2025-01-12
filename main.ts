// Qwen API 配置
const QWEN_API_URL = 'https://chat.qwenlm.ai/api/chat/completions';
const QWEN_MODELS_URL = 'https://chat.qwenlm.ai/api/models';
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1秒

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, options: RequestInit, retries = MAX_RETRIES): Promise<Response> {
  let lastError: any;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      
      // 克隆响应以便检查
      const responseClone = response.clone();
      const responseText = await responseClone.text();
      const contentType = response.headers.get('content-type') || '';
      
      // 如果返回 HTML 错误页面或 500 错误，进行重试
      if (contentType.includes('text/html') || response.status === 500) {
        lastError = {
          status: response.status,
          contentType,
          responseText: responseText.slice(0, 1000),
          headers: Object.fromEntries(response.headers.entries())
        };
        
        // 如果不是最后一次重试，则继续
        if (i < retries - 1) {
          await sleep(RETRY_DELAY * (i + 1)); // 指数退避
          continue;
        }
      }
      
      // 返回原始响应的新副本
      return new Response(responseText, {
        status: response.status,
        headers: {
          'Content-Type': contentType || 'application/json',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }
      });
    } catch (error) {
      lastError = error;
      if (i < retries - 1) {
        await sleep(RETRY_DELAY * (i + 1));
        continue;
      }
    }
  }
  
  // 所有重试都失败了
  throw new Error(JSON.stringify({
    error: true,
    message: 'All retry attempts failed',
    lastError,
    retries
  }));
}

async function processLine(line: string, writer: WritableStreamDefaultWriter<Uint8Array>, previousContent: string): Promise<string> {
  const encoder = new TextEncoder();
  try {
    const data = JSON.parse(line.slice(6));
    if (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content) {
      const currentContent = data.choices[0].delta.content;
      // 计算新的增量内容
      let newContent = currentContent;
      if (currentContent.startsWith(previousContent) && previousContent.length > 0) {
        newContent = currentContent.slice(previousContent.length);
      }
      
      // 创建新的响应对象
      const newData = {
        ...data,
        choices: [{
          ...data.choices[0],
          delta: {
            ...data.choices[0].delta,
            content: newContent
          }
        }]
      };
      
      // 发送新的响应
      await writer.write(encoder.encode(`data: ${JSON.stringify(newData)}\n\n`));
      return currentContent;
    } else {
      // 如果没有内容，直接转发原始数据
      await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      return previousContent;
    }
  } catch (e) {
    // 如果解析失败，直接转发原始数据
    await writer.write(encoder.encode(`${line}\n\n`));
    return previousContent;
  }
}

// 处理流
async function handleStream(reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array>, previousContent: string, timeout: NodeJS.Timeout): Promise<void> {
  const encoder = new TextEncoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        clearTimeout(timeout);
        // 处理剩余的缓冲区
        if (buffer) {
          const lines = buffer.split('\n');
          for (const line of lines) {
            if (line.trim().startsWith('data: ')) {
              await processLine(line, writer, previousContent);
            }
          }
        }
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
        break;
      }

      const chunk = new TextDecoder().decode(value);
      buffer += chunk;

      // 处理完整的行
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留不完整的行

      for (const line of lines) {
        if (line.trim().startsWith('data: ')) {
          const result = await processLine(line, writer, previousContent);
          if (result) {
            previousContent = result;
          }
        }
      }
    }
  } catch (error) {
    clearTimeout(timeout);
    await writer.write(encoder.encode(`data: {"error":true,"message":"${error.message}"}\n\n`));
    await writer.write(encoder.encode('data: [DONE]\n\n'));
    await writer.close();
  }
}

async function handleRequest(request: Request): Promise<Response> {
  try {
    // 处理获取模型列表的请求
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/models') {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response('Unauthorized', { 
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          }
        });
      }

      try {
        const response = await fetchWithRetry(QWEN_MODELS_URL, {
          headers: {
            'Authorization': authHeader
          }
        });

        const modelsResponse = await response.text();
        return new Response(modelsResponse, {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          error: true,
          message: error.message
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          }
        });
      }
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { 
        status: 405,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }
      });
    }

    // 获取授权头
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response('Unauthorized', { 
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }
      });
    }

    const requestData = await request.json();
    const { messages, stream = false, model, max_tokens } = requestData;

    if (!model) {
      return new Response(JSON.stringify({
        error: true,
        message: 'Model parameter is required'
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }
      });
    }

    // 构建发送到 Qwen 的请求
    const qwenRequest = {
      model,
      messages,
      stream
    };

    // 只有当用户设置了 max_tokens 时才添加
    if (max_tokens !== undefined) {
      qwenRequest.max_tokens = max_tokens;
    }

    // 发送请求到 Qwen API
    const response = await fetch(QWEN_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify(qwenRequest)
    });

    // 如果是流式响应
    if (stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const reader = response.body.getReader();
      let previousContent = '';

      // 设置超时
      const timeout = setTimeout(() => {
        writer.write(new TextEncoder().encode('data: {"error":true,"message":"Response timeout"}\n\n'));
        writer.write(new TextEncoder().encode('data: [DONE]\n\n'));
        writer.close();
      }, 60000);

      // 处理流
      handleStream(reader, writer, previousContent, timeout).catch(async (error) => {
        clearTimeout(timeout);
        const encoder = new TextEncoder();
        await writer.write(encoder.encode(`data: {"error":true,"message":"${error.message}"}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }
      });
    }

    // 非流式响应
    const responseText = await response.text();
    return new Response(responseText, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: true,
      message: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });
  }
}

Deno.serve(handleRequest);
