-- CreateTable
CREATE TABLE `Meeting` (
    `id` VARCHAR(36) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `createdByParticipantId` VARCHAR(191) NOT NULL,
    `facilitatorParticipantId` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `endedAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `Meeting_teamId_startedAt_id_idx`(`teamId`, `startedAt`, `id`),
    INDEX `Meeting_teamId_createdByParticipantId_idx`(`teamId`, `createdByParticipantId`),
    INDEX `Meeting_teamId_facilitatorParticipantId_idx`(`teamId`, `facilitatorParticipantId`),
    UNIQUE INDEX `Meeting_teamId_id_key`(`teamId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MeetingProject` (
    `id` VARCHAR(36) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `meetingId` VARCHAR(36) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL,
    `nameSnapshot` VARCHAR(200) NOT NULL,

    INDEX `MeetingProject_teamId_projectId_idx`(`teamId`, `projectId`),
    UNIQUE INDEX `MeetingProject_teamId_id_key`(`teamId`, `id`),
    UNIQUE INDEX `MeetingProject_meetingId_projectId_key`(`meetingId`, `projectId`),
    UNIQUE INDEX `MeetingProject_meetingId_position_key`(`meetingId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MeetingConfirmation` (
    `id` VARCHAR(36) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `entryId` VARCHAR(36) NOT NULL,
    `progress` INTEGER NOT NULL,
    `status` ENUM('NOT_STARTED', 'IN_PROGRESS', 'REVIEW', 'ON_HOLD', 'DONE') NOT NULL,
    `projectVersion` INTEGER NOT NULL,
    `confirmedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `confirmedByParticipantId` VARCHAR(191) NOT NULL,
    `confirmedByNameSnapshot` TEXT NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedByParticipantId` VARCHAR(191) NULL,
    `revokedByNameSnapshot` TEXT NULL,

    INDEX `MeetingConfirmation_teamId_entryId_confirmedAt_id_idx`(`teamId`, `entryId`, `confirmedAt`, `id`),
    INDEX `MeetingConfirmation_teamId_confirmedByParticipantId_idx`(`teamId`, `confirmedByParticipantId`),
    INDEX `MeetingConfirmation_teamId_revokedByParticipantId_idx`(`teamId`, `revokedByParticipantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Meeting` ADD CONSTRAINT `Meeting_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Meeting` ADD CONSTRAINT `Meeting_teamId_createdByParticipantId_fkey` FOREIGN KEY (`teamId`, `createdByParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Meeting` ADD CONSTRAINT `Meeting_teamId_facilitatorParticipantId_fkey` FOREIGN KEY (`teamId`, `facilitatorParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingProject` ADD CONSTRAINT `MeetingProject_teamId_meetingId_fkey` FOREIGN KEY (`teamId`, `meetingId`) REFERENCES `Meeting`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingProject` ADD CONSTRAINT `MeetingProject_teamId_projectId_fkey` FOREIGN KEY (`teamId`, `projectId`) REFERENCES `Project`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingConfirmation` ADD CONSTRAINT `MeetingConfirmation_teamId_entryId_fkey` FOREIGN KEY (`teamId`, `entryId`) REFERENCES `MeetingProject`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingConfirmation` ADD CONSTRAINT `MeetingConfirmation_teamId_confirmedByParticipantId_fkey` FOREIGN KEY (`teamId`, `confirmedByParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingConfirmation` ADD CONSTRAINT `MeetingConfirmation_teamId_revokedByParticipantId_fkey` FOREIGN KEY (`teamId`, `revokedByParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
