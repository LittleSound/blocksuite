import { defineBlockSchema, type SchemaToModel } from '@blocksuite/store';

export type AttachmentProps = {
  name: string;
  size: number;
  /**
   * MIME type
   */
  type: string;
  caption?: string;

  // `loadingKey` is used to indicate whether the attachment is loading
  // You can query the loading state by `isAttachmentLoading(loadingKey)`
  // We can not use `loading: true` directly because the state will be stored in the model
  //
  // The `loadingKey` and `sourceId` should not be existed at the same time
  loadingKey?: string | null;
  sourceId?: string;

  // This information comes from pictures.
  // If the user switches between pictures and attachments,
  // this information should be retained.
  imageWidth?: number;
  imageHeight?: number;
};

export const defaultAttachmentProps: AttachmentProps = {
  name: '',
  size: 0,
  type: 'application/octet-stream',
  sourceId: undefined,
  loadingKey: undefined,
  caption: undefined,
  imageWidth: undefined,
  imageHeight: undefined,
};

export const AttachmentBlockSchema = defineBlockSchema({
  flavour: 'affine:attachment',
  props: (): AttachmentProps => defaultAttachmentProps,
  metadata: {
    version: 1,
    role: 'content',
    parent: ['affine:note'],
  },
});

export type AttachmentBlockModel = SchemaToModel<typeof AttachmentBlockSchema>;
