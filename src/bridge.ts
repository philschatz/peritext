/**
 * Logic for interfacing between ProseMirror and CRDT.
 */

import { unstable as Automerge } from "@automerge/automerge"
import { Mark as AutomergeMark, Patch, Prop } from '@automerge/automerge-wasm'
import { EditorState, TextSelection, Transaction } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { Schema, Slice, Node, Fragment, Mark, Attrs } from "prosemirror-model"
import { baseKeymap, toggleMark } from "prosemirror-commands"
import { keymap } from "prosemirror-keymap"
import { ALL_MARKS, isMarkType, MarkType, schemaSpec } from "./schema"
import { ReplaceStep, AddMarkStep, RemoveMarkStep } from "prosemirror-transform"
import { ChangeQueue } from "./changeQueue"
import type { DocSchema } from "./schema"
import type { Publisher } from "./pubsub"
import type { Comment, CommentId } from "./comment"
import { v4 as uuid } from "uuid"
import { clamp } from "lodash"

export const schema = new Schema(schemaSpec)

type ActorId = string
export type Change = Uint8Array
const CONTENT_KEY = "my_text"
type DocType = { my_text: string }

export type RootDoc = {
    my_text: string
    comments: Record<CommentId, Comment>
}

type CommentMarkValue = {
    id: string
}

type BooleanMarkValue = { active: boolean }
type LinkMarkValue = { url: string }

export type MarkValue = Assert<
    {
        strong: BooleanMarkValue
        em: BooleanMarkValue
        comment: CommentMarkValue
        link: LinkMarkValue
    },
    { [K in MarkType]: Record<string, unknown> }
>


interface AddMarkOperationInputBase<M extends MarkType> {
    action: "addMark"
    /** Index in the list to apply the mark start, inclusive. */
    startIndex: number
    /** Index in the list to end the mark, exclusive. */
    endIndex: number
    /** Mark to add. */
    markType: M
}

// TODO: automatically populate attrs type w/o manual enumeration
export type AddMarkOperationInput = Values<{
    [M in MarkType]: keyof Omit<MarkValue[M], "active"> extends never
    ? AddMarkOperationInputBase<M> & { attrs?: undefined }
    : AddMarkOperationInputBase<M> & {
        attrs: Required<Omit<MarkValue[M], "active">>
    }
}>


// This is a factory which returns a Prosemirror command.
// The Prosemirror command adds a mark to the document.
// The mark takes on the position of the current selection,
// and has the given type and attributes.
// (The structure/usage of this is similar to the toggleMark command factory
// built in to prosemirror)
function addMark<M extends MarkType>(args: { markType: M; makeAttrs: () => Omit<MarkValue[M], "opId" | "active"> }) {
    const { markType, makeAttrs } = args
    const command = (
        state: EditorState,
        dispatch: ((t: Transaction) => void) | undefined,
    ) => {
        const tr = state.tr
        const { $from, $to } = state.selection.ranges[0]
        const from = $from.pos,
            to = $to.pos
        tr.addMark(from, to, schema.marks[markType].create(makeAttrs()))
        if (dispatch !== undefined) {
            dispatch(tr)
        }
        return true
    }
    return command
}

const richTextKeymap: any = {
    ...baseKeymap,
    "Mod-b": toggleMark(schema.marks.strong),
    "Mod-i": toggleMark(schema.marks.em),
    "Mod-e": addMark({
        markType: "comment",
        makeAttrs: () => ({ id: uuid() }),
    }),
    "Mod-k": addMark({
        markType: "link",
        makeAttrs: () => ({
            url: `https://www.google.com/search?q=${uuid()}`,
        }),
    }),
}

export type Editor = {
    // doc: Automerge.Doc<DocType>
    view: EditorView
    queue: ChangeQueue
    outputDebugForChange: (change: Change) => void
}

const describeMarkType = (markType: string): string => {
    switch (markType) {
        case "em":
            return "italic"
        case "strong":
            return "bold"
        default:
            return markType
    }
}

/** Initialize multiple Micromerge docs to all have same base editor state.
 *  The key is that all docs get initialized with a single change that originates
 *  on one of the docs; this avoids weird issues where each doc independently
 *  tries to initialize the basic structure of the document.
 */
export const initializeDocs = (text: string, initialInputOps?: AddMarkOperationInput[]): [Automerge.Doc<DocType>, Automerge.Doc<DocType>] => {
    let doc = Automerge.from({ my_text: text })
    if (initialInputOps) {
        doc = Automerge.change(doc, doc => {
            for (const op of initialInputOps) {
                if (op.action === 'addMark') {
                    if (op.markType === "comment") {
                        if (!op.attrs || typeof op.attrs.id !== "string") {
                            throw new Error("Expected comment mark to have id attrs")
                        }
                        Automerge.mark(doc, CONTENT_KEY, `${op.markType}:${op.attrs.id}`, buildRange(op.markType, op.startIndex, op.endIndex), true)
                    } else if (op.markType === "link") {
                        if (!op.attrs || typeof op.attrs.url !== "string") {
                            throw new Error("Expected link mark to have url attrs")
                        }
                        Automerge.mark(doc, CONTENT_KEY, `${op.markType}`, buildRange(op.markType, op.startIndex, op.endIndex), op.attrs.url)
                    } else {
                        Automerge.mark(doc, CONTENT_KEY, `${op.markType}`, buildRange(op.markType, op.startIndex, op.endIndex), true)
                    }
                }
            }
        })
    }
    return [doc, Automerge.clone(doc)]
}

function getMarkInfo(mark: { key: string, value: any }) {
    const [key, subkey] = mark.key.split(':') // for comment:{uuid}
    let attr: Attrs | undefined = undefined
    if (key === 'link')
        attr = { url: mark.value }
    if (key === 'comment') {
        attr = { id: subkey, text: mark.value }
    }
    return { key, attr }
}

/** Extends a Prosemirror Transaction with new steps incorporating
 *  the effects of a Micromerge Patch.
 *
 *  @param transaction - the original transaction to extend
 *  @param patch - the Micromerge Patch to incorporate
 *  @returns
 *      transaction: a Transaction that includes additional steps representing the patch
 *      startPos: the Prosemirror position where the patch's effects start
 *      endPos: the Prosemirror position where the patch's effects end
 *    */
export const extendProsemirrorTransactionWithMicromergePatch = <T>(
    doc: Automerge.Doc<T>,
    transaction: Transaction,
    patch: Automerge.Patch,
): { transaction: Transaction; startPos: number; endPos: number } => {
    console.log("applying patch", patch)
    let startPos = Number.POSITIVE_INFINITY
    let endPos = Number.NEGATIVE_INFINITY
    switch (patch.action) {
        case "splice": {
            const [_key, startIndex] = patch.path
            const index = prosemirrorPosFromContentPos(startIndex as number)
            return {
                transaction: transaction.replace(
                    index,
                    index,
                    new Slice(
                        Fragment.from(schema.text(patch.value, getProsemirrorMarksForMarkMap(doc, CONTENT_KEY, index))),
                        0,
                        0,
                    ),
                ),
                startPos: index,
                endPos: index + 1,
            }
        }
        case "del": {
            const [_key, startIndex] = patch.path
            const index = prosemirrorPosFromContentPos(startIndex as number)
            const length = patch.length || 1
            return {
                transaction: transaction.replace(index, index + length, Slice.empty),
                startPos: index,
                endPos: index,
            }
        }

        case "mark": {
            for (const mark of patch.marks) {
                const { key, attr } = getMarkInfo(mark)
                if (mark.value === false) {
                    transaction = transaction.removeMark(
                        prosemirrorPosFromContentPos(mark.start),
                        prosemirrorPosFromContentPos(mark.end),
                        schema.mark(key, attr)
                    )
                } else {
                    transaction = transaction.addMark(
                        prosemirrorPosFromContentPos(mark.start),
                        prosemirrorPosFromContentPos(mark.end),
                        schema.mark(key, attr)
                    )
                }
                startPos = Math.min(startPos, mark.start)
                endPos = Math.max(endPos, mark.end)
            }
            return {
                transaction,
                startPos: prosemirrorPosFromContentPos(startPos),
                endPos: prosemirrorPosFromContentPos(endPos),
            }
        }
    }

    if (patch.action as any === 'unmark') {
        const { start, end, key } = patch as unknown as { start: number, end: number, key: string }
        return {
            transaction: transaction.removeMark(
                prosemirrorPosFromContentPos(start),
                prosemirrorPosFromContentPos(end),
                schema.mark(key),
            ),
            startPos: prosemirrorPosFromContentPos(start),
            endPos: prosemirrorPosFromContentPos(end),
        }
    }
    throw new Error(`BUG: Unsupported patch type '${patch.action}'`)
}

/** Construct a Prosemirror editor instance on a DOM node, and bind it to a Micromerge doc  */
export function createEditor(args: {
    actorId: ActorId
    editorNode: Element
    changesNode: Element
    doc: Automerge.Doc<DocType>
    publisher: Publisher<Array<Change>>
    editable: boolean
    handleClickOn?: (
        this: unknown,
        view: EditorView,
        pos: number,
        node: Node,
        nodePos: number,
        event: MouseEvent,
        direct: boolean,
    ) => boolean
    onRemotePatchApplied?: (args: {
        transaction: Transaction
        view: EditorView
        startPos: number
        endPos: number
    }) => Transaction
}): Editor {
    const { actorId, editorNode, changesNode, publisher, handleClickOn, onRemotePatchApplied, editable } = args
    let { doc } = args
    const queue = new ChangeQueue({
        handleFlush: (changes: Array<Change>) => {
            publisher.publish(actorId, changes)
        },
    })
    queue.start()

    const outputDebugForChange = (change: Change) => {
        // const opsDivs = change.ops.map((op: InternalOperation) => `<div class="op">${describeOp(op)}</div>`)

        // for (const divHtml of opsDivs) {
        //     changesNode.insertAdjacentHTML("beforeend", divHtml)
        // }
        // changesNode.scrollTop = changesNode.scrollHeight
    }

    publisher.subscribe(actorId, incomingChanges => {
        if (incomingChanges.length === 0) {
            return
        }

        let state = view.state

        // For each incoming change, we:
        // - retrieve Patches from Micromerge describing the effect of applying the change
        // - construct a Prosemirror Transaction representing those effecst
        // - apply that Prosemirror Transaction to the document

        let transaction = state.tr
        let patches: null | Automerge.Patch[] = null
        const prevDoc = doc
        console.log('calling applyChanges. Doc currently has ', Automerge.getAllChanges(doc).length, Automerge.getActorId(doc), Automerge.marks(doc, CONTENT_KEY))
        doc = Automerge.applyChanges(doc, incomingChanges, {
            patchCallback: (p) => {
                console.log('Setting patches!!!!', p)
                patches = p
            }
        })[0]
        console.log('called applyChanges. Doc now has ', Automerge.getAllChanges(doc).length, Automerge.getActorId(doc), Automerge.marks(doc, CONTENT_KEY))

        if (!patches) {
            console.log('Expected to see some changes', Automerge.marks(prevDoc, CONTENT_KEY), Automerge.marks(doc, CONTENT_KEY))
            console.log('previous heads', Automerge.getHeads(prevDoc))
            console.log('current heads', Automerge.getHeads(doc))
            debugger
        }

        for (const patch of patches || []) {
            // Get a new Prosemirror transaction containing the effects of the Micromerge patch
            const result = extendProsemirrorTransactionWithMicromergePatch(doc, transaction, patch)
            let { transaction: newTransaction } = result
            const { startPos, endPos } = result

            // If this editor has a callback function defined for handling a remote patch being applied,
            // apply that callback and give it the chance to extend the transaction.
            // (e.g. this can be used to visualize changes by adding new marks.)
            if (onRemotePatchApplied) {
                newTransaction = onRemotePatchApplied({
                    transaction: newTransaction,
                    view,
                    startPos,
                    endPos,
                })
            }

            // Assign the newly modified transaction
            transaction = newTransaction
        }


        state = state.apply(transaction)
        view.updateState(state)
    })

    // Generate an empty document conforming to the schema,
    // and a default selection at the start of the document.
    const state = EditorState.create({
        schema,
        plugins: [keymap(richTextKeymap)],
        doc: prosemirrorDocFromCRDT({
            schema,
            // spans: doc.getTextWithFormatting([CONTENT_KEY]),
            text: doc[CONTENT_KEY].toString()
        }),
    })

    // Create a view for the state and generate transactions when the user types.
    const view = new EditorView(editorNode, {
        // state.doc is a read-only data structure using a node hierarchy
        // A node contains a fragment with zero or more child nodes.
        // Text is modeled as a flat sequence of tokens.
        // Each document has a unique valid representation.
        // Order of marks specified by schema.
        state,
        handleClickOn,
        editable: () => editable,
        // We intercept local Prosemirror transactions and derive Micromerge changes from them
        dispatchTransaction: (txn: Transaction) => {
            let state = view.state

            // Apply a corresponding change to the Micromerge document.
            // We observe a Micromerge Patch from applying the change, and
            // apply its effects to our local Prosemirror doc.
            const result = applyProsemirrorTransactionToMicromergeDoc({ doc, txn })
            const { change, patches } = result
            doc = result.doc

            if (change) {
                let transaction = state.tr
                for (const patch of patches) {
                    const { transaction: newTxn } = extendProsemirrorTransactionWithMicromergePatch(doc, transaction, patch)
                    transaction = newTxn
                }
                state = state.apply(transaction)
                outputDebugForChange(change)

                // Broadcast the change to remote peers
                queue.enqueue(change)
            }

            // If this transaction updated the local selection, we need to
            // make sure that's reflected in the editor state.
            // (Roundtripping through Micromerge won't do that for us, since
            // selection state is not part of the document state.)
            if (txn.selectionSet) {
                state = state.apply(
                    state.tr.setSelection(
                        new TextSelection(
                            state.doc.resolve(txn.selection.anchor),
                            state.doc.resolve(txn.selection.head),
                        ),
                    ),
                )
            }

            view.updateState(state)
            console.groupEnd()
        },
    })

    return { view, queue, outputDebugForChange }
}

/**
 * Converts a position in the Prosemirror doc to an offset in the CRDT content string.
 * For now we only have a single node so this is relatively trivial.
 * In the future when things get more complicated with multiple block nodes,
 * we can probably take advantage
 * of the additional metadata that Prosemirror can provide by "resolving" the position.
 * @param position : an unresolved Prosemirror position in the doc;
 * @param doc : the Prosemirror document containing the position
 */
function contentPosFromProsemirrorPos(position: number, doc: Node): number {
    // The -1 accounts for the extra character at the beginning of the PM doc
    // containing the beginning of the paragraph.
    // In some rare cases we can end up with incoming positions outside of the single
    // paragraph node (e.g., when the user does cmd-A to select all),
    // so we need to be sure to clamp the resulting position to inside the paragraph node.
    return clamp(position - 1, 0, doc.textContent.length)
}

/** Given an index in the text CRDT, convert to an index in the Prosemirror editor.
 *  The Prosemirror editor has a paragraph node which we ignore because we only handle inline;
 *  the beginning of the paragraph takes up one position in the Prosemirror indexing scheme.
 *  This means we have to add 1 to CRDT indexes to get correct Prosemirror indexes.
 */
function prosemirrorPosFromContentPos(position: number) {
    return position + 1
}

function getProsemirrorMarksForMarkMap<T>(doc: Automerge.Doc<T>, prop: Prop, index: number): readonly Mark[] {
    const marks = Automerge.marks(doc, prop).filter(m => m.start <= index && m.end >= index)
    return marks.map(mark => {
        const { key, attr } = getMarkInfo(mark)
        return schema.marks[key].create(attr)
    })
}

// Given a micromerge doc representation, produce a prosemirror doc.
export function prosemirrorDocFromCRDT(args: { schema: DocSchema; text: string }): Node {
    const { schema, text } = args

    // Prosemirror doesn't allow for empty text nodes;
    // if our doc is empty, we short-circuit and don't add any text nodes.
    if (text === "") {
        return schema.node("doc", undefined, [schema.node("paragraph", [])])
    }

    const result = schema.node("doc", undefined, [
        schema.node(
            "paragraph",
            undefined,
            schema.text(text, []), // getProsemirrorMarksForMarkMap(span.marks))
        ),
    ])

    return result
}

function buildRange(markType: string, start: number, end: number) {
    switch (markType) {
        case 'comment':
        case 'link':
            return `[${start}..${end}]`
        case 'em':
        case 'strong':
            return `(${start}..${end})`
        default:
            throw new Error('BUG: unreachable')
    }
}

// Given a CRDT Doc and a Prosemirror Transaction, update the micromerge doc.
export function applyProsemirrorTransactionToMicromergeDoc(args: { doc: Automerge.Doc<DocType>; txn: Transaction }): {
    change: Change | null
    patches: Patch[]
    doc: Automerge.Doc<DocType>
} {
    const initialDoc = args.doc
    const { txn } = args

    if (txn.steps.length === 0) {
        return { doc: initialDoc, change: null, patches: [] }
    }
    let patches: Patch[] = []
    const doc = Automerge.change(initialDoc, {
        patchCallback: (p) => {
            patches = p
        }
    }, doc => {

        for (const step of txn.steps) {
            if (step instanceof ReplaceStep) {
                const from = contentPosFromProsemirrorPos(step.from, txn.before)
                const to = contentPosFromProsemirrorPos(step.to, txn.before)
                if (step.slice) {
                    // handle insertion
                    // This step coalesces the multiple paragraphs back into one paragraph. Because step.slice.content is a Fragment and step.slice.content.content is 2 Paragraph nodes
                    const insertedContent = step.slice.content.textBetween(0, step.slice.content.size)
                    Automerge.splice(doc, CONTENT_KEY, from, to - from, insertedContent)
                } else {
                    // handle deletion
                    Automerge.splice(doc, CONTENT_KEY, from, to - from)
                }
            } else if (step instanceof AddMarkStep) {
                if (!isMarkType(step.mark.type.name)) {
                    throw new Error(`Invalid mark type: ${step.mark.type.name}`)
                }

                const from = contentPosFromProsemirrorPos(step.from, txn.before)
                const to = contentPosFromProsemirrorPos(step.to, txn.before)

                const markName = step.mark.type.name
                if (markName === "comment") {
                    if (!step.mark.attrs || typeof step.mark.attrs.id !== "string") {
                        throw new Error("Expected comment mark to have id attrs")
                    }
                    Automerge.mark(doc, CONTENT_KEY, `${markName}:${step.mark.attrs.id}`, buildRange(markName, from, to), true)
                } else if (markName === "link") {
                    if (!step.mark.attrs || typeof step.mark.attrs.url !== "string") {
                        throw new Error("Expected link mark to have url attrs")
                    }
                    Automerge.mark(doc, CONTENT_KEY, `${markName}`, buildRange(markName, from, to), step.mark.attrs.url)
                } else {
                    Automerge.mark(doc, CONTENT_KEY, `${markName}`, buildRange(markName, from, to), true)
                }
            } else if (step instanceof RemoveMarkStep) {
                if (!isMarkType(step.mark.type.name)) {
                    throw new Error(`Invalid mark type: ${step.mark.type.name}`)
                }

                const from = contentPosFromProsemirrorPos(step.from, txn.before)
                const to = contentPosFromProsemirrorPos(step.to, txn.before)

                if (step.mark.type.name === "comment") {
                    if (!step.mark.attrs || typeof step.mark.attrs.id !== "string") {
                        throw new Error("Expected comment mark to have id attrs")
                    }
                    Automerge.unmark(doc, CONTENT_KEY, `${step.mark.type.name}:${step.mark.attrs.id}`, from, to)
                } else {
                    Automerge.unmark(doc, CONTENT_KEY, step.mark.type.name, from, to)
                }
            }
        }

    })

    const changes = Automerge.getChanges(initialDoc, doc)
    if (changes.length > 1) throw new Error('BUG: Expected only one change')
    return { doc, change: changes[0], patches }
}
