export const LEFT_FIXTURE = [
  "M src/auth/session.ts",
  "M src/payments/capture.ts",
  "M src/really/really/really/long/path/checkout-service.ts",
  "M src/中文檔案.ts",
  "M src/🚀-worker.ts",
  "M tests/auth/session.test.ts",
  "M tests/payments/capture.test.ts",
  "M src/a.ts",
  "M src/b.ts",
  "M src/c.ts",
  "M src/d.ts",
  "M src/e.ts",
  "M src/f.ts",
  "M src/g.ts",
  "M src/h.ts",
  "M src/i.ts",
  "M src/j.ts",
  "M src/k.ts",
  "M src/l.ts",
  "M src/m.ts",
  "M src/n.ts",
  "M src/o.ts",
  "M src/p.ts",
  "M src/q.ts",
  "M src/r.ts",
  "M src/s.ts",
  "M src/t.ts",
  "M src/u.ts",
  "M src/v.ts",
  "M src/w.ts",
  "M src/x.ts",
  "M src/y.ts",
  "M src/z.ts",
  "M src/aa.ts",
  "M src/ab.ts",
  "M src/ac.ts",
  "M src/ad.ts",
  "M src/ae.ts",
  "M src/af.ts",
  "M src/ag.ts",
  "M src/ah.ts",
  "M src/ai.ts",
  "M src/aj.ts",
  "M src/ak.ts",
  "M src/al.ts",
  "M src/am.ts",
  "M src/an.ts",
  "M src/ao.ts",
] as const

export const PATCH_SENTINELS = [
  "GITHUNK_PATCH_ONLY_ALPHA",
  "GITHUNK_PATCH_ONLY_OMEGA",
] as const

export const PATCH_FIXTURE = `diff --git a/src/payments/capture.ts b/src/payments/capture.ts
index 1111111..2222222 100644
--- a/src/payments/capture.ts
+++ b/src/payments/capture.ts
@@ -120,8 +120,14 @@ export async function capturePayment(order: Order) {
-\tconst result = await legacyCapture(order)
+\tconst result = await capture(order)
+\tconst reviewLabel = "中文審查 🚀 e\u0301 GITHUNK_PATCH_ONLY_ALPHA"
+
+\tconst intentionallyLongLine = "this line is deliberately long so that a narrow patch pane forces wrapping while the logical source line remains one line for clipboard validation"
+
+\tif (!result.ok) {
+\t\tthrow new Error("capture failed")
+\t}
 
 \treturn result
 }
@@ -210,3 +216,4 @@ function audit() {
-  return "old"
+  return "new"
+  // GITHUNK_PATCH_ONLY_OMEGA
 }
`
