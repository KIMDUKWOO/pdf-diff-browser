import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, rgb } from "pdf-lib";
import Diff from "diff";

// ✅ GitHub Pages 안전 worker 경로
pdfjsLib.GlobalWorkerOptions.workerSrc =
  import.meta.env.BASE_URL + "pdfjs/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);

const log = (msg) => {
  const el = $("log");
  el.textContent += (el.textContent ? "\n" : "") + msg;
};

const setStatus = (msg, p = null) => {
  $("status").textContent = msg ?? "";
  if (p !== null) $("prog").value = p;
};

function clearUI() {
  $("log").textContent = "";
  $("prog").value = 0;
  $("status").textContent = "";
}

async function fileToUint8Array(file) {
  return new Uint8Array(await file.arrayBuffer());
}

// server.js와 동일: 토큰 정규화
function normalizeToken(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

// server.js와 동일: item -> bbox
function itemToBbox(item) {
  const [, , , d, e, f] = item.transform;

  const x = e;
  const y = f;

  const w = item.width ?? 0;
  const h = item.height ?? Math.abs(d) ?? 0;

  // baseline 보정 (server와 동일)
  const yAdj = y - h * 0.2;

  return { x, y: yAdj, w, h };
}

// ✅ 핵심: server.js의 extractWordTokensWithBoxes를 그대로 브라우저로 옮김
async function extractWordTokensWithBoxes(pdfBytes) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
  const pdf = await loadingTask.promise;

  const tokens = [];

  for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
    const page = await pdf.getPage(pageIndex + 1);

    // server는 기본 getTextContent() 사용. 필요하면 disableCombineTextItems: true로 변경 가능
    const content = await page.getTextContent();

    let current = null; // { text, pageIndex, bbox }

    const flush = () => {
      if (current && current.text.trim()) tokens.push(current);
      current = null;
    };

    for (const item of content.items) {
      const s = item.str || "";
      const norm = s.replace(/\s+/g, " ");

      // 공백만이면 토큰 끊기
      if (!norm.trim()) {
        flush();
        continue;
      }

      const bbox = itemToBbox(item);

      // item이 여러 단어를 포함할 수 있으니 분리
      const parts = norm.split(" ").filter(Boolean);

      if (parts.length === 1) {
        if (!current) {
          current = { text: parts[0], pageIndex, bbox };
        } else {
          // 이어붙이기 + bbox 확장 (server와 동일)
          current.text += parts[0];

          const x1 = Math.min(current.bbox.x, bbox.x);
          const y1 = Math.min(current.bbox.y, bbox.y);
          const x2 = Math.max(current.bbox.x + current.bbox.w, bbox.x + bbox.w);
          const y2 = Math.max(current.bbox.y + current.bbox.h, bbox.y + bbox.h);

          current.bbox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        }
      } else {
        // 여러 단어면 기존 토큰 flush 후 각각 저장(폭을 대충 나눔)
        flush();

        const approxW = bbox.w / parts.length;

        parts.forEach((p, i) => {
          tokens.push({
            text: p,
            pageIndex,
            bbox: {
              x: bbox.x + approxW * i,
              y: bbox.y,
              w: approxW,
              h: bbox.h,
            },
          });
        });
      }
    }

    flush();
  }

  return tokens
    .map((t) => ({ ...t, text: normalizeToken(t.text) }))
    .filter((t) => t.text.length > 0);
}

// server.js와 동일: diffArrays로 added index 만들기
function buildAddedTokenIndexes(words1, words2) {
  const diffs = Diff.diffArrays(words1, words2);

  const addedIndexes = [];
  let idx2 = 0;

  for (const part of diffs) {
    if (part.added) {
      for (let i = 0; i < part.value.length; i++) {
        addedIndexes.push(idx2 + i);
      }
      idx2 += part.value.length;
    } else if (part.removed) {
      // idx2 변화 없음
    } else {
      idx2 += part.value.length;
    }
  }
  return addedIndexes;
}

async function highlightPdf2(pdf2Bytes, tokens2, addedIdx) {
  const pdfDoc = await PDFDocument.load(pdf2Bytes);
  const pages = pdfDoc.getPages();

  for (const i of addedIdx) {
    const t = tokens2[i];
    if (!t) continue;

    const page = pages[t.pageIndex];
    if (!page) continue;

    const padX = 1.0;
    const padY = 1.0;

    page.drawRectangle({
      x: t.bbox.x - padX,
      y: t.bbox.y - padY,
      width: t.bbox.w + padX * 2,
      height: t.bbox.h + padY * 2,
      color: rgb(1, 1, 0),
      opacity: 0.35,
      borderWidth: 0,
    });
  }

  return await pdfDoc.save();
}

function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("run").addEventListener("click", async () => {
  clearUI();

  const fileA = $("pdfA").files?.[0];
  const fileB = $("pdfB").files?.[0];

  if (!fileA || !fileB) {
    alert("PDF1(기준), PDF2(대상) 파일을 둘 다 선택해줘.");
    return;
  }

  try {
    setStatus("파일 로딩...", 2);
    log("PDF 로딩 시작");

    // ✅ detached 방지: pdf.js용 / pdf-lib용 bytes 분리
    const [bytesA, bytesB] = await Promise.all([
      fileToUint8Array(fileA),
      fileToUint8Array(fileB),
    ]);

    const bytesA_forPdfJs = bytesA.slice();
    const bytesB_forPdfJs = bytesB.slice();
    const bytesB_forPdfLib = bytesB.slice();

    setStatus("PDF1 토큰 추출...", 15);
    const tokens1 = await extractWordTokensWithBoxes(bytesA_forPdfJs);

    setStatus("PDF2 토큰 추출...", 45);
    const tokens2 = await extractWordTokensWithBoxes(bytesB_forPdfJs);

    const words1 = tokens1.map((t) => t.text);
    const words2 = tokens2.map((t) => t.text);

    setStatus("diff 계산...", 70);
    const addedIdx = buildAddedTokenIndexes(words1, words2);

    log(`PDF1 토큰: ${words1.length}`);
    log(`PDF2 토큰: ${words2.length}`);
    log(`추가 토큰 수: ${addedIdx.length}`);

    if (addedIdx.length === 0) {
      setStatus("추가된 단어 없음", 100);
      alert("추가된 단어를 찾지 못했어요(변경 없음/추출 실패).");
      return;
    }

    setStatus("하이라이트 PDF 생성...", 90);
    const outBytes = await highlightPdf2(bytesB_forPdfLib, tokens2, addedIdx);

    setStatus("완료! 다운로드", 100);
    downloadBytes(outBytes, "highlighted_precise.pdf");
    log("완료: highlighted_precise.pdf 다운로드");
  } catch (e) {
    console.error(e);
    log("ERROR: " + (e?.message || String(e)));
    setStatus("에러 발생", 0);
    alert("에러 발생. 콘솔(F12) 확인.");
  }
});
