/*
  Warnings:

  - You are about to drop the `_serverImageTosystemPrompt` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `serverImage` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `serverImages` to the `systemPrompt` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "_serverImageTosystemPrompt_B_index";

-- DropIndex
DROP INDEX "_serverImageTosystemPrompt_AB_unique";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "_serverImageTosystemPrompt";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "serverImage";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_systemPrompt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "textPromptID" INTEGER NOT NULL,
    "serverImages" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "systemPrompt_textPromptID_fkey" FOREIGN KEY ("textPromptID") REFERENCES "textPrompt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_systemPrompt" ("createdAt", "id", "textPromptID", "updatedAt") SELECT "createdAt", "id", "textPromptID", "updatedAt" FROM "systemPrompt";
DROP TABLE "systemPrompt";
ALTER TABLE "new_systemPrompt" RENAME TO "systemPrompt";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
