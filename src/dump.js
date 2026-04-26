const fs = require('fs');
const ts = require('typescript');

const sourceFile = ts.createSourceFile(
  'agent.ts',
  fs.readFileSync('d:/AntigravityProjects/AgentPact/node-runtime-core/src/agent.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true
);

function printClassMethods(node) {
  if (ts.isClassDeclaration(node)) {
    console.log(Class: );
    node.members.forEach(member => {
      if (ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) {
        const name = member.name?.getText(sourceFile);
        const modifiers = member.modifiers?.map(m => m.getText(sourceFile)).join(' ') || '';
        const kind = ts.isMethodDeclaration(member) ? 'Method' : 'Property';
        console.log(  []  );
      }
    });
  }
  ts.forEachChild(node, printClassMethods);
}

printClassMethods(sourceFile);