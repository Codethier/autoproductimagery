/*
  Warnings:

  - You are about to drop the column `textPrompt` on the `systemPrompt` table. All the data in the column will be lost.
  - Added the required column `textPromptId` to the `systemPrompt` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "TextPrompt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "textPrompt" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_systemPrompt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "textPromptId" TEXT NOT NULL,
    "serverImages" JSONB NOT NULL,
    "outputImage" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "systemPrompt_textPromptId_fkey" FOREIGN KEY ("textPromptId") REFERENCES "TextPrompt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_systemPrompt" ("createdAt", "id", "outputImage", "serverImages", "updatedAt") SELECT "createdAt", "id", "outputImage", "serverImages", "updatedAt" FROM "systemPrompt";
DROP TABLE "systemPrompt";
ALTER TABLE "new_systemPrompt" RENAME TO "systemPrompt";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
