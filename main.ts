
// Qwen API 配置
const QWEN_API_URL = "https://chat.qwenlm.ai/api/chat/completions";
const QWEN_MODELS_URL = "https://chat.qwenlm.ai/api/models";
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1秒

const encoder = new TextEncoder();
const streamDecoder = new TextDecoder();

let cachedModels: string | null = null;
let cachedModelsTimestamp = 0;
const CACHE_TTL = 60 * 60 * 1000; // 缓存 1 小时

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = MAX_RETRIES,
): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);

      if (response.ok) {
        return response;
      }

      const contentType = response.headers.get("content-type") || "";
      if (response.status >= 500 || contentType.includes("text/html")) {
        const responseClone = response.clone();
        const responseText = await responseClone.text();
        lastError = {
          status: response.status,
          contentType,
          responseText: responseText.slice(0, 1000),
          headers: Object.fromEntries(response.headers.entries()),
        };

        if (i < retries - 1) {
          await sleep(RETRY_DELAY * (i + 1));
          continue;
        }
      } else {
        // 对于非 5xx 错误，不再重试
        lastError = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        };
        break;
      }
    } catch (error) {
      lastError = error;
      if (i < retries - 1) {
        await sleep(RETRY_DELAY * (i + 1));
        continue;
      }
    }
  }

  throw new Error(JSON.stringify({
    error: true,
    message: "All retry attempts failed",
    lastError,
    retries,
  }));
}

async function processLine(
  line: string,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  previousContent: string,
): Promise<string> {
  try {
    const data = JSON.parse(line.slice(6));
    if (
      data.choices && data.choices[0] && data.choices[0].delta &&
      data.choices[0].delta.content
    ) {
      const currentContent: string = data.choices[0].delta.content;
      let newContent = currentContent;

      if (currentContent.startsWith(previousContent) && previousContent.length > 0) {
        newContent = currentContent.slice(previousContent.length);
      }

      if (newContent) { // 仅当有新内容时才发送
        const newData = {
          ...data,
          choices: [{
            ...data.choices[0],
            delta: {
              ...data.choices[0].delta,
              content: newContent,
            },
          }],
        };
        await writer.write(
          encoder.encode(`data: ${JSON.stringify(newData)}\n\n`),
        );
      }
      return currentContent;
    } else {
      await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      return previousContent;
    }
  } catch {
    await writer.write(encoder.encode(`${line}\n\n`));
    return previousContent;
  }
}

async function handleStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  previousContent: string,
  timeout: number,
) {
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        clearTimeout(timeout);
        if (buffer) {
          const lines = buffer.split("\n");
          for (const line of lines) {
            if (line.trim().startsWith("data: ")) {
              await processLine(line, writer, previousContent);
            }
          }
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        await writer.close();
        break;
      }

      const valueText = streamDecoder.decode(value, { stream: true });

      buffer += valueText;

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim().startsWith("data: ")) {
          const result = await processLine(line, writer, previousContent);
          if (result) {
            previousContent = result;
          }
        }
      }
    }
  } catch (error) {
    clearTimeout(timeout);
    await writer.write(
      encoder.encode(`data: {"error":true,"message":"${error.message}"}\n\n`),
    );
    await writer.write(encoder.encode("data: [DONE]\n\n"));
    await writer.close();
  }
}

async function handleRequest(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/api/models") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response("Unauthorized", { status: 401 });
      }

      const now = Date.now();
      if (cachedModels && now - cachedModelsTimestamp < CACHE_TTL) {
        return new Response(cachedModels, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      }

      try {
        const response = await fetchWithRetry(QWEN_MODELS_URL, {
          headers: {
            "Authorization": authHeader,
          },
        });

        cachedModels = await response.text();
        cachedModelsTimestamp = now;

        return new Response(cachedModels, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: true, message: error.message }),
          { status: 500 },
        );
      }
    }

    if (request.method !== "POST" || pathname !== "/api/chat/completions") {
      return new Response("Method not allowed", { status: 405 });
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }

    const requestData = await request.json();
    const { messages, stream = false, model, max_tokens } = requestData;

    if (!model) {
      return new Response(
        JSON.stringify({ error: true, message: "Model parameter is required" }),
        { status: 400 },
      );
    }

    const qwenRequest = {
      model,
      messages,
      stream,
    };

    if (max_tokens !== undefined) {
      qwenRequest.max_tokens = max_tokens;
    }

    const qwenResponse = await fetch(QWEN_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader,
      },
      body: JSON.stringify(qwenRequest),
    });

    if (stream) {
      const { readable, writable } = new TransformStream<
        Uint8Array,
        Uint8Array
      >();
      const writer = writable.getWriter();
      const reader = qwenResponse.body!.getReader();

      const timeout = setTimeout(async () => {
        try {
          await writer.write(
            encoder.encode(
              'data: {"error":true,"message":"Response timeout"}\n\n',
            ),
          );
          await writer.write(encoder.encode("data: [DONE]\n\n"));
          await writer.close();
        } catch {
          // writer closed
        }
      }, 60000);

      handleStream(reader, writer, "", timeout).catch(async (error) => {
        clearTimeout(timeout);
        try {
          await writer.write(
            encoder.encode(
              `data: {"error":true,"message":"${error.message}"}\n\n`,
            ),
          );
          await writer.write(encoder.encode("data: [DONE]\n\n"));
          await writer.close();
        } catch {
          // writer closed
        }
      });

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    const responseText = await qwenResponse.text();
    return new Response(responseText, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: true, message: error.message }),
      { status: 500 },
    );
  }
}

Deno.serve(handleRequest);
