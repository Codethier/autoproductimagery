/*
  Warnings:

  - Added the required column `modelImages` to the `systemPrompt` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_systemPrompt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "TextPrompt" TEXT NOT NULL,
    "serverImages" JSONB NOT NULL,
    "modelImages" JSONB NOT NULL,
    "outputImage" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_systemPrompt" ("TextPrompt", "createdAt", "id", "outputImage", "serverImages", "updatedAt") SELECT "TextPrompt", "createdAt", "id", "outputImage", "serverImages", "updatedAt" FROM "systemPrompt";
DROP TABLE "systemPrompt";
ALTER TABLE "new_systemPrompt" RENAME TO "systemPrompt";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
