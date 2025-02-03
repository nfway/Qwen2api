// Qwen API 配置
const QWEN_API_URL = "https://chat.qwenlm.ai/api/chat/completions";
const QWEN_MODELS_URL = "https://chat.qwenlm.ai/api/models";
const QWEN_FILES_URL = "https://chat.qwenlm.ai/api/v1/files/"; // 文件上传接口
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1秒
const STREAM_TIMEOUT = 600000; // 60秒超时
const CACHE_TTL = 60 * 60 * 1000; // 缓存 1 小时

const encoder = new TextEncoder();
const streamDecoder = new TextDecoder();

// 缓存相关
let cachedModels: string | null = null;
let cachedModelsTimestamp = 0;

// 工具函数
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 带重试的fetch函数
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

// 上传图片到 QwenLM
async function uploadImageToQwen(token: string, imageBlob: Blob): Promise<string> {
    const formData = new FormData();
    formData.append('file', imageBlob);

    console.log('文件大小:', imageBlob.size); // 日志输出
    console.log('文件类型:', imageBlob.type); // 日志输出

    try {
        const response = await fetchWithRetry(QWEN_FILES_URL, {
            method: "POST",
            headers: {
                "Authorization": token, // 使用传入的 Token
                "accept": "application/json",
            },
            body: formData,
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('文件上传失败:', response.status, errorText); // 日志输出
            throw new Error(`文件上传失败: ${response.statusText}`);
        }

        const data = await response.json();
        if (!data.id) {
            throw new Error("文件上传失败: 未返回有效的文件ID");
        }

        console.log('上传图片成功，imageId:', data.id); // 日志输出
        return data.id;
    } catch (error) {
        console.error('上传图片时发生错误:', error); // 日志输出
        throw error;
    }
}

// 将 base64 转换为 Blob
function base64ToBlob(base64: string): Blob {
    const byteString = atob(base64.split(',')[1]);
    const mimeString = base64.split(',')[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], { type: mimeString });
}

// 流处理相关的接口和类型
interface StreamState {
    isCompleted: boolean;
    isStreamActive: boolean;
    previousContent: string;
}

interface StreamContext {
    writer: WritableStreamDefaultWriter<Uint8Array>;
    reader: ReadableStreamDefaultReader<Uint8Array>;
    state: StreamState;
    timeoutId?: NodeJS.Timeout; // 确保使用正确的Timeout类型
}

// 处理单行数据
async function processLine(
    line: string,
    context: StreamContext,
): Promise<void> {
    try {
        const data = JSON.parse(line.slice(6));
        if (
            data.choices &&
            data.choices[0] &&
            data.choices[0].delta &&
            data.choices[0].delta.content
        ) {
            const currentContent: string = data.choices[0].delta.content;
            let newContent = currentContent;

            if (currentContent.startsWith(context.state.previousContent) &&
                context.state.previousContent.length > 0) {
                newContent = currentContent.slice(context.state.previousContent.length);
            }

            if (newContent) {
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
                await context.writer.write(
                    encoder.encode(`data: ${JSON.stringify(newData)}\n\n`),
                );
            }
            context.state.previousContent = currentContent;
        } else {
            console.log('无content数据:', JSON.stringify(data));
            await context.writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        }
    } catch (error) {
        console.error('处理行数据时发生错误:', error);
        await context.writer.write(encoder.encode(`${line}\n\n`));
    }
}

// 处理流数据
async function handleStream(context: StreamContext): Promise<void> {
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await context.reader.read();

            if (done) {
                context.state.isCompleted = true;
                if (context.timeoutId) {
                    clearTimeout(context.timeoutId);
                }

                if (buffer) {
                    const lines = buffer.split("\n");
                    for (const line of lines) {
                        if (line.trim().startsWith("data: ")) {
                            await processLine(line, context);
                        }
                    }
                }

                console.log('流处理自然完成');
                await context.writer.write(encoder.encode("data: [DONE]\n\n"));
                break;
            }

            const valueText = streamDecoder.decode(value, { stream: true });
            buffer += valueText;

            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (line.trim().startsWith("data: ")) {
                    await processLine(line, context);
                }
            }
        }
    } catch (error) {
        console.error('流处理发生错误:', error);
        if (!context.state.isCompleted) {
            if (context.timeoutId) {
                clearTimeout(context.timeoutId);
            }
            try {
                await context.writer.write(
                    encoder.encode(
                        `data: {"error":true,"message":"${error.message}"}\n\n`
                    )
                );
                await context.writer.write(encoder.encode("data: [DONE]\n\n"));
            } catch (writeError) {
                console.error('写入错误信息时发生错误:', writeError);
            }
        }
    } finally {
        try {
            await context.writer.close();
        } catch (closeError) {
            console.error('关闭writer时发生错误:', closeError);
        }
    }
}

async function handleRequest(request: Request): Promise<Response> {
    try {
        const url = new URL(request.url);
        const pathname = url.pathname;

        console.log(`请求路径: ${pathname}, 方法: ${request.method}`); // 日志输出

        if (request.method === "GET" && pathname === "/v1/models") {
            const authHeader = request.headers.get("Authorization");
            if (!authHeader || !authHeader.startsWith("Bearer ")) {
                console.log('未授权访问'); // 日志输出
                return new Response("Unauthorized", { status: 401 });
            }

            const now = Date.now();
            if (cachedModels && now - cachedModelsTimestamp < CACHE_TTL) {
                console.log('返回缓存模型'); // 日志输出
                return new Response(cachedModels, {
                    headers: {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                    },
                });
            }

            try {
                console.log('请求模型列表'); // 日志输出
                const response = await fetchWithRetry(QWEN_MODELS_URL, {
                    headers: {
                        "Authorization": authHeader,
                    },
                });

                cachedModels = await response.text();
                cachedModelsTimestamp = now;

                console.log('模型列表获取成功'); // 日志输出
                return new Response(cachedModels, {
                    headers: {
                        "Content-Type": "application/json",
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                    },
                });
            } catch (error) {
                console.error('获取模型列表失败:', error); // 日志输出
                return new Response(
                    JSON.stringify({ error: true, message: error.message }),
                    { status: 500 },
                );
            }
        }

        // 处理聊天完成请求
        if (request.method !== "POST" || pathname !== "/v1/chat/completions") {
            console.log('方法不允许'); // 日志输出
            return new Response("Method not allowed", { status: 405 });
        }

        const authHeader = request.headers.get("Authorization");
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            console.log('未授权访问'); // 日志输出
            return new Response("Unauthorized", { status: 401 });
        }

        const requestData = await request.json();
        console.log('请求数据:', JSON.stringify(requestData)); // 日志输出

        const { messages, stream = false, model, max_tokens } = requestData;

        if (!model) {
            console.log('缺少模型参数'); // 日志输出
            return new Response(
                JSON.stringify({ error: true, message: "Model parameter is required" }),
                { status: 400 },
            );
        }

        // 检查消息中是否包含 base64 图片
        const updatedMessages = await Promise.all(messages.map(async (message: any) => {
            if (message.content && Array.isArray(message.content)) {
                message.content = await Promise.all(message.content.map(async (content: any) => {
                    if (content.type === "image_url" && content.image_url?.url?.startsWith("data:")) {
                        console.log('检测到 base64 图片'); // 日志输出
                        const imageBlob = base64ToBlob(content.image_url.url);
                        const imageId = await uploadImageToQwen(authHeader, imageBlob);
                        console.log('上传图片成功，imageId:', imageId); // 日志输出
                        return {
                            type: "image",
                            image: imageId, // 替换为上传后的 imageId
                        };
                    }
                    return content;
                }));
            }
            return message;
        }));

        const qwenRequest = {
            model,
            messages: updatedMessages,
            stream,
            ...(max_tokens !== undefined && { max_tokens }),
        };

        console.log('发送给 Qwen 的请求:', JSON.stringify(qwenRequest)); // 日志输出

        const qwenResponse = await fetch(QWEN_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": authHeader,
            },
            body: JSON.stringify(qwenRequest),
        });

        if (stream) {
            const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
            const writer = writable.getWriter();
            const reader = qwenResponse.body!.getReader();

            const streamContext: StreamContext = {
                writer,
                reader,
                state: {
                    isCompleted: false,
                    isStreamActive: true,
                    previousContent: "",
                },
                timeoutId: setTimeout(() => {
                    if (streamContext.state.isStreamActive && !streamContext.state.isCompleted) {
                        console.log('触发流超时');
                        streamContext.state.isStreamActive = false;
                        writer.write(encoder.encode('data: {"error":true,"message":"Response timeout"}\n\n'))
                            .then(() => writer.write(encoder.encode("data: [DONE]\n\n")))
                            .then(() => writer.close())
                            .catch(err => console.error('超时处理错误:', err));
                    }
                }, STREAM_TIMEOUT),
            };

            handleStream(streamContext).catch(async (error) => {
                clearTimeout(streamContext.timeoutId!);
                try {
                    await writer.write(encoder.encode(`data: {"error":true,"message":"${error.message}"}\n\n`));
                    await writer.write(encoder.encode("data: [DONE]\n\n"));
                    await writer.close();
                } catch {
                    // 忽略写入错误
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
        console.log('Qwen 响应:', responseText); // 日志输出
        return new Response(responseText, {
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        });
    } catch (error) {
        console.error('处理请求时发生错误:', error); // 日志输出
        return new Response(
            JSON.stringify({ error: true, message: error.message }),
            { status: 500 },
        );
    }
}

Deno.serve(handleRequest);
