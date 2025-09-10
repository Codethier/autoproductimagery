-- CreateTable
CREATE TABLE "systemPrompt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "textPromptID" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "systemPrompt_textPromptID_fkey" FOREIGN KEY ("textPromptID") REFERENCES "textPrompt" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "serverImage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "path" TEXT NOT NULL,
    "isModel" BOOLEAN NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "textPrompt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "_serverImageTosystemPrompt" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,
    CONSTRAINT "_serverImageTosystemPrompt_A_fkey" FOREIGN KEY ("A") REFERENCES "serverImage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_serverImageTosystemPrompt_B_fkey" FOREIGN KEY ("B") REFERENCES "systemPrompt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "_serverImageTosystemPrompt_AB_unique" ON "_serverImageTosystemPrompt"("A", "B");

-- CreateIndex
CREATE INDEX "_serverImageTosystemPrompt_B_index" ON "_serverImageTosystemPrompt"("B");
