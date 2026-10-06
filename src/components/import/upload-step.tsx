"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { FormError } from "@/components/forms/field";
import {
  fileTooBigMessage,
  IMPORT_ACCEPT,
  MAX_UPLOAD_BYTES,
  unsupportedFileMessage,
} from "@/core/import/limits";
import type { UploadResponse } from "@/core/import/types";
import { cn } from "@/lib/utils";

type SheetPick = { file: File; upload: UploadResponse; sheet: string };

function errorFrom(data: unknown): string | null {
  if (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string") {
    return (data as { error: string }).error;
  }
  return null;
}

/** Import step 1: drop or pick a file, or paste rows from Excel / Google Sheets. */
export function UploadStep() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const pasteId = useId();
  const sheetGroupId = useId();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<null | "file" | "paste">(null);
  const [error, setErrorState] = useState<{ where: "file" | "paste"; message: string } | null>(null);
  const [text, setText] = useState("");
  const [pick, setPick] = useState<SheetPick | null>(null);

  async function send(form: FormData, where: "file" | "paste"): Promise<UploadResponse | null> {
    const setError = (message: string) => setErrorState({ where, message });
    let res: Response;
    try {
      res = await fetch("/api/imports", { method: "POST", body: form });
    } catch {
      setError("The upload didn't reach the app. Check the connection to the office PC and try again.");
      return null;
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      setError(
        errorFrom(data) ??
          (res.status === 401
            ? "Your session has ended. Sign in again, then import the file."
            : res.status === 413
              ? "This file is too big; the limit is 8 MB. Split it into two files."
              : "The upload didn't work. Try again."),
      );
      return null;
    }
    return data as UploadResponse;
  }

  async function uploadFile(file: File) {
    setErrorState(null);
    const unsupported = unsupportedFileMessage(file.name);
    if (unsupported) {
      setErrorState({ where: "file", message: unsupported });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setErrorState({ where: "file", message: fileTooBigMessage(file.size) });
      return;
    }
    setBusy("file");
    const form = new FormData();
    form.set("file", file);
    const up = await send(form, "file");
    if (!up) {
      setBusy(null);
      return;
    }
    if (up.sheets.length > 1) {
      setPick({ file, upload: up, sheet: up.sheet ?? up.sheets[0]!.name });
      setBusy(null);
      return;
    }
    router.push(`/import/${up.id}`);
  }

  async function continueWithSheet() {
    if (!pick) return;
    setErrorState(null);
    if (pick.sheet === pick.upload.sheet) {
      setBusy("file");
      router.push(`/import/${pick.upload.id}`);
      return;
    }
    setBusy("file");
    const form = new FormData();
    form.set("file", pick.file);
    form.set("sheet", pick.sheet);
    form.set("replace", String(pick.upload.id));
    const up = await send(form, "file");
    if (!up) {
      setBusy(null);
      return;
    }
    router.push(`/import/${up.id}`);
  }

  async function uploadText() {
    setErrorState(null);
    if (!text.trim()) {
      setErrorState({ where: "paste", message: "Paste the rows first, including the header row." });
      return;
    }
    const size = new Blob([text]).size;
    if (size > MAX_UPLOAD_BYTES) {
      setErrorState({ where: "paste", message: fileTooBigMessage(size, true) });
      return;
    }
    setBusy("paste");
    const form = new FormData();
    form.set("text", text);
    const up = await send(form, "paste");
    if (!up) {
      setBusy(null);
      return;
    }
    router.push(`/import/${up.id}`);
  }

  if (pick) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Which sheet do you want to import?</CardTitle>
          <CardDescription>
            {pick.file.name} has {pick.upload.sheets.length} sheets. Pick one; to import another sheet too, upload the file again afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <FormError message={error?.message} />
          <RadioGroup
            aria-label="Sheet"
            value={pick.sheet}
            onValueChange={(sheet) => setPick({ ...pick, sheet })}
            className="gap-3"
          >
            {pick.upload.sheets.map((s, i) => (
              <div key={s.name} className="flex items-center gap-3">
                <RadioGroupItem value={s.name} id={`${sheetGroupId}-${i}`} disabled={s.rows === 0} />
                <Label htmlFor={`${sheetGroupId}-${i}`} className={cn("font-normal", s.rows === 0 && "text-muted-foreground")}>
                  <span className="font-medium">{s.name}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {s.rows === 0 ? "empty" : `about ${s.rows.toLocaleString("en-US")} row${s.rows === 1 ? "" : "s"}`}
                  </span>
                </Label>
              </div>
            ))}
          </RadioGroup>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={continueWithSheet} disabled={busy !== null}>
              {busy ? "Reading the sheet…" : "Continue with this sheet"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => {
                setPick(null);
                setErrorState(null);
              }}
            >
              Choose another file
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Upload a file</CardTitle>
          <CardDescription>
            CSV, TXT, XLSX or XLS, up to 8 MB. The first row should hold the column names.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error?.where === "file" ? <FormError message={error.message} /> : null}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (!dragging) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file && busy === null) void uploadFile(file);
            }}
            className={cn(
              "flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-10 text-center transition-colors",
              dragging ? "border-foreground/60 bg-muted" : "border-border",
            )}
          >
            <FileSpreadsheet className="size-8 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">
              {busy === "file" ? "Reading the file…" : "Drop a file here, or"}
            </p>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => inputRef.current?.click()}>
              <Upload aria-hidden />
              Choose a file
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept={IMPORT_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void uploadFile(file);
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            One row per person is fine: rows with the same website or company name become one company with several people.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Or paste rows</CardTitle>
          <CardDescription>Paste rows from Excel or Google Sheets, including the header row.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {error?.where === "paste" ? <FormError message={error.message} /> : null}
          <Label htmlFor={pasteId} className="sr-only">
            Rows to import
          </Label>
          <Textarea
            id={pasteId}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Company\tWebsite\tEmail\nMüller 3D Druck\tmueller3d.de\tinfo@mueller3d.de"}
            spellCheck={false}
            className="min-h-40 font-mono text-xs"
          />
          <div>
            <Button type="button" onClick={uploadText} disabled={busy !== null || !text.trim()}>
              {busy === "paste" ? "Reading the rows…" : "Use these rows"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
