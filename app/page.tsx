"use client";

import { useChat } from "@ai-sdk/react";
import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import type { ChatUIMessage, MessageMetadata } from "@/lib/chat/types";

const QUICK_QUESTIONS = ["怎么退换货？", "发什么快递？", "尺码怎么选？"] as const;

const WELCOME =
  "您好，欢迎来到天乐时代旗舰店。我是店铺金牌客服，可以帮您查询尺码、退换货和物流。请问有什么可以帮您？";

function messageText(message: ChatUIMessage) {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** 回答依据：让「查了哪张卡片」可见，出错时能区分是检索错还是生成错 */
function SourceNote({ metadata }: { metadata?: MessageMetadata }) {
  if (!metadata) return null;

  if (!metadata.grounded || metadata.sources.length === 0) {
    return (
      <p className="mt-1 px-1 text-[11px] leading-4 text-zinc-400">未命中知识库，已转人工</p>
    );
  }

  const label = metadata.sources
    .map((source) => `${source.docTitle} · ${source.section}`)
    .join("；");

  // 悬停可看到 chunk id 与分数，方便定位具体命中了哪一段
  const detail = metadata.sources
    .map((source) => `${source.id}（score ${source.score}）`)
    .join("\n");

  return (
    <p className="mt-1 px-1 text-[11px] leading-4 text-zinc-400" title={detail}>
      依据：{label}
    </p>
  );
}

export default function Home() {
  const { messages, sendMessage, status, error } = useChat<ChatUIMessage>();
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  function submitText(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    void sendMessage({ text: trimmed });
    setInput("");
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitText(input);
  }

  const lastMessage = messages.at(-1);
  const showTyping =
    status === "submitted" ||
    (status === "streaming" &&
      (!lastMessage ||
        lastMessage.role !== "assistant" ||
        messageText(lastMessage).length === 0));

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#e8e4dc] p-3 sm:p-6">
      <section className="flex h-[min(860px,calc(100dvh-1.5rem))] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-[#ededed] shadow-xl ring-1 ring-black/5 sm:h-[min(860px,calc(100dvh-3rem))]">
        <header className="flex items-center gap-3 bg-[#2f6f4e] px-4 py-3 text-white">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white/15 text-sm font-semibold">
            客
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-wide">
              天乐时代旗舰店在线客服
            </h1>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-white/80">
              <span className="size-1.5 rounded-full bg-[#7dffb3]" />
              金牌客服在线
            </p>
          </div>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
          <Bubble role="assistant" text={WELCOME} />

          {messages.map((message) => {
            const text = messageText(message);
            if (!text) return null;
            return (
              <Bubble
                key={message.id}
                role={message.role}
                text={text}
                note={message.role === "assistant" ? <SourceNote metadata={message.metadata} /> : null}
              />
            );
          })}

          {showTyping ? (
            <div className="flex items-end gap-2">
              <Avatar label="客" />
              <div className="rounded-2xl rounded-bl-sm bg-white px-4 py-3 shadow-sm">
                <span className="inline-flex gap-1">
                  <span className="size-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:0ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:150ms]" />
                  <span className="size-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:300ms]" />
                </span>
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              暂时无法回复，请稍后再试。
            </p>
          ) : null}

          <div ref={bottomRef} />
        </div>

        <form onSubmit={onSubmit} className="border-t border-black/5 bg-[#f7f7f7] px-3 pt-3 pb-3">
          <div className="mb-2 flex gap-2 overflow-x-auto">
            {QUICK_QUESTIONS.map((question) => (
              <button
                key={question}
                type="button"
                disabled={busy}
                onClick={() => submitText(question)}
                className="shrink-0 rounded-full border border-[#2f6f4e]/25 bg-white px-3 py-1.5 text-xs text-[#2f6f4e] transition hover:bg-[#2f6f4e]/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {question}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="请输入您的问题…"
              disabled={busy}
              className="h-11 min-w-0 flex-1 rounded-full border border-black/10 bg-white px-4 text-sm outline-none placeholder:text-zinc-400 focus:border-[#2f6f4e]"
            />
            <button
              type="submit"
              disabled={busy || input.trim().length === 0}
              className="h-11 shrink-0 rounded-full bg-[#2f6f4e] px-4 text-sm font-medium text-white transition hover:bg-[#275c41] disabled:cursor-not-allowed disabled:opacity-50"
            >
              发送
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function Avatar({ label }: { label: string }) {
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#2f6f4e] text-xs font-medium text-white">
      {label}
    </div>
  );
}

function Bubble({
  role,
  text,
  note,
}: {
  role: "user" | "assistant" | "system";
  text: string;
  note?: ReactNode;
}) {
  const isUser = role === "user";

  return (
    <div className={`flex items-end gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
      <Avatar label={isUser ? "我" : "客"} />
      <div className="flex min-w-0 max-w-[78%] flex-col">
        <div
          className={`rounded-2xl px-3.5 py-2.5 text-sm leading-6 whitespace-pre-wrap shadow-sm ${
            isUser
              ? "rounded-br-sm bg-[#95ec69] text-zinc-900"
              : "rounded-bl-sm bg-white text-zinc-800"
          }`}
        >
          {text}
        </div>
        {note}
      </div>
    </div>
  );
}
