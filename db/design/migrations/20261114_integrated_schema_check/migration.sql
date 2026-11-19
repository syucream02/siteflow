-- CreateTable
CREATE TABLE `user` (
    `id` VARCHAR(191) NOT NULL,
    `name` TEXT NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `emailVerified` BOOLEAN NOT NULL DEFAULT false,
    `image` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `user_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `session` (
    `id` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `token` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `ipAddress` TEXT NULL,
    `userAgent` TEXT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `activeOrganizationId` TEXT NULL,

    INDEX `session_userId_idx`(`userId`),
    UNIQUE INDEX `session_token_key`(`token`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `account` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` TEXT NOT NULL,
    `providerId` TEXT NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `accessToken` TEXT NULL,
    `refreshToken` TEXT NULL,
    `idToken` TEXT NULL,
    `accessTokenExpiresAt` DATETIME(3) NULL,
    `refreshTokenExpiresAt` DATETIME(3) NULL,
    `scope` TEXT NULL,
    `password` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `account_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `verification` (
    `id` VARCHAR(191) NOT NULL,
    `identifier` TEXT NOT NULL,
    `value` TEXT NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `verification_identifier_idx`(`identifier`(191)),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Team` (
    `id` VARCHAR(191) NOT NULL,
    `name` TEXT NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `logo` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `metadata` TEXT NULL,

    UNIQUE INDEX `Team_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TeamMembership` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `role` ENUM('admin', 'member') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL,

    INDEX `TeamMembership_userId_idx`(`userId`),
    UNIQUE INDEX `TeamMembership_teamId_userId_key`(`teamId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invitation` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `email` TEXT NOT NULL,
    `role` ENUM('admin', 'member') NULL,
    `status` TEXT NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `inviterId` VARCHAR(191) NOT NULL,

    INDEX `invitation_teamId_idx`(`teamId`),
    INDEX `invitation_email_idx`(`email`(191)),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TeamParticipant` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TeamParticipant_userId_idx`(`userId`),
    UNIQUE INDEX `TeamParticipant_teamId_userId_key`(`teamId`, `userId`),
    UNIQUE INDEX `TeamParticipant_teamId_id_key`(`teamId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Project` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `primaryParticipantId` VARCHAR(191) NOT NULL,
    `createdByParticipantId` VARCHAR(191) NOT NULL,
    `createdByNameSnapshot` TEXT NOT NULL,
    `dueDate` DATE NOT NULL,
    `progress` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('NOT_STARTED', 'IN_PROGRESS', 'REVIEW', 'ON_HOLD', 'DONE') NOT NULL DEFAULT 'NOT_STARTED',
    `code` VARCHAR(100) NULL,
    `summary` TEXT NULL,
    `clientName` VARCHAR(200) NULL,
    `notes` TEXT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Project_teamId_archivedAt_dueDate_idx`(`teamId`, `archivedAt`, `dueDate`),
    INDEX `Project_teamId_primaryParticipantId_idx`(`teamId`, `primaryParticipantId`),
    INDEX `Project_teamId_createdByParticipantId_idx`(`teamId`, `createdByParticipantId`),
    UNIQUE INDEX `Project_teamId_id_key`(`teamId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProjectSupportMember` (
    `teamId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ProjectSupportMember_teamId_projectId_idx`(`teamId`, `projectId`),
    INDEX `ProjectSupportMember_teamId_participantId_idx`(`teamId`, `participantId`),
    PRIMARY KEY (`projectId`, `participantId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProjectProgressHistory` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `changedByParticipantId` VARCHAR(191) NOT NULL,
    `changedByNameSnapshot` TEXT NOT NULL,
    `previousProgress` INTEGER NOT NULL,
    `nextProgress` INTEGER NOT NULL,
    `previousStatus` ENUM('NOT_STARTED', 'IN_PROGRESS', 'REVIEW', 'ON_HOLD', 'DONE') NOT NULL,
    `nextStatus` ENUM('NOT_STARTED', 'IN_PROGRESS', 'REVIEW', 'ON_HOLD', 'DONE') NOT NULL,
    `comment` TEXT NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ProjectProgressHistory_teamId_projectId_changedAt_id_idx`(`teamId`, `projectId`, `changedAt`, `id`),
    INDEX `ProjectProgressHistory_teamId_changedByParticipantId_idx`(`teamId`, `changedByParticipantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProjectAssignmentHistory` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `kind` ENUM('PRIMARY_CHANGE', 'SUPPORT_ADD', 'SUPPORT_REMOVE') NOT NULL,
    `previousParticipantId` VARCHAR(191) NULL,
    `nextParticipantId` VARCHAR(191) NULL,
    `changedByParticipantId` VARCHAR(191) NOT NULL,
    `previousNameSnapshot` TEXT NULL,
    `nextNameSnapshot` TEXT NULL,
    `changedByNameSnapshot` TEXT NOT NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ProjectAssignmentHistory_teamId_projectId_changedAt_id_idx`(`teamId`, `projectId`, `changedAt`, `id`),
    INDEX `ProjectAssignmentHistory_teamId_previousParticipantId_idx`(`teamId`, `previousParticipantId`),
    INDEX `ProjectAssignmentHistory_teamId_nextParticipantId_idx`(`teamId`, `nextParticipantId`),
    INDEX `ProjectAssignmentHistory_teamId_changedByParticipantId_idx`(`teamId`, `changedByParticipantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `session` ADD CONSTRAINT `session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `account` ADD CONSTRAINT `account_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TeamMembership` ADD CONSTRAINT `TeamMembership_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `TeamMembership` ADD CONSTRAINT `TeamMembership_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invitation` ADD CONSTRAINT `invitation_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `invitation` ADD CONSTRAINT `invitation_inviterId_fkey` FOREIGN KEY (`inviterId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `TeamParticipant` ADD CONSTRAINT `TeamParticipant_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `TeamParticipant` ADD CONSTRAINT `TeamParticipant_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_teamId_primaryParticipantId_fkey` FOREIGN KEY (`teamId`, `primaryParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_teamId_createdByParticipantId_fkey` FOREIGN KEY (`teamId`, `createdByParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ProjectSupportMember` ADD CONSTRAINT `ProjectSupportMember_teamId_projectId_fkey` FOREIGN KEY (`teamId`, `projectId`) REFERENCES `Project`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ProjectSupportMember` ADD CONSTRAINT `ProjectSupportMember_teamId_participantId_fkey` FOREIGN KEY (`teamId`, `participantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ProjectProgressHistory` ADD CONSTRAINT `ProjectProgressHistory_teamId_projectId_fkey` FOREIGN KEY (`teamId`, `projectId`) REFERENCES `Project`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ProjectProgressHistory` ADD CONSTRAINT `ProjectProgressHistory_teamId_changedByParticipantId_fkey` FOREIGN KEY (`teamId`, `changedByParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ProjectAssignmentHistory` ADD CONSTRAINT `ProjectAssignmentHistory_teamId_projectId_fkey` FOREIGN KEY (`teamId`, `projectId`) REFERENCES `Project`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ProjectAssignmentHistory` ADD CONSTRAINT `ProjectAssignmentHistory_teamId_previousParticipantId_fkey` FOREIGN KEY (`teamId`, `previousParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ProjectAssignmentHistory` ADD CONSTRAINT `ProjectAssignmentHistory_teamId_nextParticipantId_fkey` FOREIGN KEY (`teamId`, `nextParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ProjectAssignmentHistory` ADD CONSTRAINT `ProjectAssignmentHistory_teamId_changedByParticipantId_fkey` FOREIGN KEY (`teamId`, `changedByParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
