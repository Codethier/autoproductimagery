/*
  Warnings:

  - Added the required column `outputImage` to the `systemPrompt` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_systemPrompt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "textPromptID" INTEGER NOT NULL,
    "serverImages" JSONB NOT NULL,
    "outputImage" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "systemPrompt_textPromptID_fkey" FOREIGN KEY ("textPromptID") REFERENCES "textPrompt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_systemPrompt" ("createdAt", "id", "serverImages", "textPromptID", "updatedAt") SELECT "createdAt", "id", "serverImages", "textPromptID", "updatedAt" FROM "systemPrompt";
DROP TABLE "systemPrompt";
ALTER TABLE "new_systemPrompt" RENAME TO "systemPrompt";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
