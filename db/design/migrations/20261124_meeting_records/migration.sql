-- CreateTable
CREATE TABLE `MeetingProjectNote` (
    `id` VARCHAR(36) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `entryId` VARCHAR(36) NOT NULL,
    `consultation` TEXT NOT NULL,
    `decision` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `createdByParticipantId` VARCHAR(191) NOT NULL,
    `createdByNameSnapshot` TEXT NOT NULL,
    `updatedByParticipantId` VARCHAR(191) NOT NULL,
    `updatedByNameSnapshot` TEXT NOT NULL,

    UNIQUE INDEX `MeetingProjectNote_teamId_entryId_key`(`teamId`, `entryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MeetingActionItem` (
    `id` VARCHAR(36) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `originEntryId` VARCHAR(36) NOT NULL,
    `content` TEXT NOT NULL,
    `assigneeParticipantId` VARCHAR(191) NOT NULL,
    `assigneeNameSnapshot` TEXT NOT NULL,
    `dueDate` DATE NULL,
    `status` ENUM('OPEN', 'DONE', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `createdByParticipantId` VARCHAR(191) NOT NULL,
    `createdByNameSnapshot` TEXT NOT NULL,
    `updatedByParticipantId` VARCHAR(191) NOT NULL,
    `updatedByNameSnapshot` TEXT NOT NULL,

    INDEX `MeetingActionItem_teamId_projectId_status_id_idx`(`teamId`, `projectId`, `status`, `id`),
    UNIQUE INDEX `MeetingActionItem_teamId_projectId_id_key`(`teamId`, `projectId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MeetingActionSnapshot` (
    `id` VARCHAR(36) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `entryId` VARCHAR(36) NOT NULL,
    `actionId` VARCHAR(36) NOT NULL,
    `sourceSnapshotId` VARCHAR(36) NULL,
    `content` TEXT NOT NULL,
    `assigneeParticipantId` VARCHAR(191) NOT NULL,
    `assigneeNameSnapshot` TEXT NOT NULL,
    `dueDate` DATE NULL,
    `status` ENUM('OPEN', 'DONE', 'CANCELLED') NOT NULL,
    `actionVersion` INTEGER NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `recordedByParticipantId` VARCHAR(191) NOT NULL,
    `recordedByNameSnapshot` TEXT NOT NULL,

    INDEX `MeetingActionSnapshot_teamId_entryId_id_idx`(`teamId`, `entryId`, `id`),
    UNIQUE INDEX `MeetingActionSnapshot_teamId_entryId_actionId_key`(`teamId`, `entryId`, `actionId`),
    UNIQUE INDEX `MeetingActionSnapshot_teamId_projectId_actionId_id_key`(`teamId`, `projectId`, `actionId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `MeetingProject_teamId_projectId_id_key` ON `MeetingProject`(`teamId`, `projectId`, `id`);

-- AddForeignKey
ALTER TABLE `MeetingProjectNote` ADD CONSTRAINT `MeetingProjectNote_teamId_entryId_fkey` FOREIGN KEY (`teamId`, `entryId`) REFERENCES `MeetingProject`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingProjectNote` ADD CONSTRAINT `MeetingProjectNote_teamId_createdByParticipantId_fkey` FOREIGN KEY (`teamId`, `createdByParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingProjectNote` ADD CONSTRAINT `MeetingProjectNote_teamId_updatedByParticipantId_fkey` FOREIGN KEY (`teamId`, `updatedByParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingActionItem` ADD CONSTRAINT `MeetingActionItem_teamId_projectId_fkey` FOREIGN KEY (`teamId`, `projectId`) REFERENCES `Project`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingActionItem` ADD CONSTRAINT `MeetingActionItem_teamId_projectId_originEntryId_fkey` FOREIGN KEY (`teamId`, `projectId`, `originEntryId`) REFERENCES `MeetingProject`(`teamId`, `projectId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingActionItem` ADD CONSTRAINT `MeetingActionItem_teamId_assigneeParticipantId_fkey` FOREIGN KEY (`teamId`, `assigneeParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingActionItem` ADD CONSTRAINT `MeetingActionItem_teamId_createdByParticipantId_fkey` FOREIGN KEY (`teamId`, `createdByParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingActionItem` ADD CONSTRAINT `MeetingActionItem_teamId_updatedByParticipantId_fkey` FOREIGN KEY (`teamId`, `updatedByParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingActionSnapshot` ADD CONSTRAINT `MeetingActionSnapshot_teamId_projectId_entryId_fkey` FOREIGN KEY (`teamId`, `projectId`, `entryId`) REFERENCES `MeetingProject`(`teamId`, `projectId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingActionSnapshot` ADD CONSTRAINT `MeetingActionSnapshot_teamId_projectId_actionId_fkey` FOREIGN KEY (`teamId`, `projectId`, `actionId`) REFERENCES `MeetingActionItem`(`teamId`, `projectId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingActionSnapshot` ADD CONSTRAINT `MeetingActionSnapshot_teamId_assigneeParticipantId_fkey` FOREIGN KEY (`teamId`, `assigneeParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingActionSnapshot` ADD CONSTRAINT `MeetingActionSnapshot_teamId_recordedByParticipantId_fkey` FOREIGN KEY (`teamId`, `recordedByParticipantId`) REFERENCES `TeamParticipant`(`teamId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `MeetingActionSnapshot` ADD CONSTRAINT `MeetingActionSnapshot_teamId_projectId_actionId_sourceSnaps_fkey` FOREIGN KEY (`teamId`, `projectId`, `actionId`, `sourceSnapshotId`) REFERENCES `MeetingActionSnapshot`(`teamId`, `projectId`, `actionId`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
