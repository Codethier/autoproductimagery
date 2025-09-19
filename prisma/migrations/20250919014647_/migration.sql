/*
  Warnings:

  - You are about to drop the `Test` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `textPrompt` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `textPromptID` on the `systemPrompt` table. All the data in the column will be lost.
  - Added the required column `textPrompt` to the `systemPrompt` table without a default value. This is not possible if the table is not empty.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Test";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "textPrompt";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_systemPrompt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "textPrompt" TEXT NOT NULL,
    "serverImages" JSONB NOT NULL,
    "outputImage" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_systemPrompt" ("createdAt", "id", "outputImage", "serverImages", "updatedAt") SELECT "createdAt", "id", "outputImage", "serverImages", "updatedAt" FROM "systemPrompt";
DROP TABLE "systemPrompt";
ALTER TABLE "new_systemPrompt" RENAME TO "systemPrompt";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
